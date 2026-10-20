// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title BudgetRail
/// @notice Session-based USDC payment rail with EIP-712 authorized payouts.
/// @dev
/// Security and accounting notes:
/// 1) Forced/unsolicited token deposits:
///    This contract credits budget only through {fundSession}. Any USDC transferred directly to this
///    contract address outside {fundSession} is ignored by session accounting, not attributable to any
///    session, and cannot be recovered. There is no sweep/recovery function. Such tokens are permanently
///    locked. Users MUST fund sessions exclusively via {fundSession}.
/// 2) Token blocklist reversions:
///    Circle-issued USDC may blocklist addresses. If a session provider is blocklisted, {payForRequest}
///    transfers to that provider will revert. If a session owner is blocklisted, {closeSession} refunds
///    to that owner will revert. There is no fallback recipient or admin override in this MVP.
/// 3) Reentrancy:
///    {payForRequest} and {closeSession} are protected by {ReentrancyGuard}. State is updated before
///    external token transfers (checks-effects-interactions). {fundSession} also updates state before
///    calling transferFrom to prevent double-crediting by malicious token callbacks.
/// 4) Expiry:
///    Session expiry and quote deadlines use block.timestamp. Minor proposer timestamp drift can affect
///    boundary checks around expiration; use sufficiently generous session durations.
///
/// Accounting invariant:
/// At all times per session: totalSpent <= totalFunded <= maxBudget.
/// On close, refund = totalFunded - totalSpent and is always non-negative.
/// There is no partial withdrawal, no arbitrary-destination payout, and no admin sweep.
contract BudgetRail is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    struct Session {
        address owner;
        address agent;
        address provider;
        address quoteSigner;
        uint96 maxBudget;
        uint96 perPaymentCap;
        uint96 totalFunded;
        uint96 totalSpent;
        uint64 expiresAt;
        bool closed;
    }

    /// @dev sessionId => Session; IDs start at 1.
    mapping(uint256 => Session) private _sessions;

    /// @dev sessionId => requestId => paid marker for replay protection.
    mapping(uint256 => mapping(bytes32 => bool)) private _requestPaid;

    /// @dev owner => ordered session IDs.
    mapping(address => uint256[]) private _ownerSessions;

    /// @dev Monotonic session counter; incremented before use so the first ID is 1.
    uint256 private _nextSessionId;

    /// @notice Immutable USDC ERC-20 reference.
    IERC20 public immutable USDC_TOKEN;

    /// @notice Immutable USDC token address.
    address public immutable USDC_ADDRESS;

    /// @dev EIP-712 typehash for PaymentQuote.
    bytes32 private constant _PAYMENT_QUOTE_TYPEHASH =
        keccak256(
            "PaymentQuote(uint256 sessionId,bytes32 requestId,bytes32 requestHash,uint256 amount,uint64 quoteDeadline)"
        );

    error ZeroAddress();
    error InvalidBudget();
    error InvalidPerPaymentCap();
    error ExpiryInPast();
    error SessionNotFound();
    error NotOwner();
    error NotAgent();
    error SessionAlreadyClosed();
    error SessionExpired();
    error ZeroAmount();
    error BudgetExceeded();
    error FundedBudgetExceeded();
    error LifetimeBudgetExceeded();
    error PerPaymentCapExceeded();
    error QuoteExpired();
    error QuoteDeadlineExceedsSession();
    error RequestAlreadyPaid();
    error InvalidSignature();
    error InvalidOffset();

    event SessionCreated(
        uint256 indexed sessionId,
        address indexed owner,
        address indexed agent,
        address provider,
        address quoteSigner,
        uint96 maxBudget,
        uint96 perPaymentCap,
        uint64 expiresAt
    );

    event SessionFunded(uint256 indexed sessionId, address indexed owner, uint96 amount, uint96 totalFunded);

    event PaymentSettled(
        uint256 indexed sessionId,
        bytes32 indexed requestId,
        address indexed provider,
        bytes32 requestHash,
        address agent,
        uint96 amount,
        uint64 quoteDeadline
    );

    event SessionClosed(uint256 indexed sessionId, address indexed owner, uint96 refunded, uint96 totalSpent);

    /// @param usdcAddress Address of the USDC ERC-20 token contract.
    constructor(address usdcAddress) EIP712("BudgetRail", "1") {
        if (usdcAddress == address(0)) revert ZeroAddress();
        USDC_TOKEN = IERC20(usdcAddress);
        USDC_ADDRESS = usdcAddress;
    }

    /// @notice Creates a new payment session.
    /// @return sessionId Newly created session ID.
    function createSession(
        address agent,
        address provider,
        address quoteSigner,
        uint96 maxBudget,
        uint96 perPaymentCap,
        uint64 expiresAt
    ) external returns (uint256 sessionId) {
        if (agent == address(0) || provider == address(0) || quoteSigner == address(0)) revert ZeroAddress();
        if (maxBudget == 0) revert InvalidBudget();
        if (perPaymentCap == 0 || perPaymentCap > maxBudget) revert InvalidPerPaymentCap();
        if (expiresAt <= block.timestamp) revert ExpiryInPast();

        unchecked {
            _nextSessionId += 1;
        }
        sessionId = _nextSessionId;

        _sessions[sessionId] = Session({
            owner: msg.sender,
            agent: agent,
            provider: provider,
            quoteSigner: quoteSigner,
            maxBudget: maxBudget,
            perPaymentCap: perPaymentCap,
            totalFunded: 0,
            totalSpent: 0,
            expiresAt: expiresAt,
            closed: false
        });

        _ownerSessions[msg.sender].push(sessionId);

        emit SessionCreated(
            sessionId,
            msg.sender,
            agent,
            provider,
            quoteSigner,
            maxBudget,
            perPaymentCap,
            expiresAt
        );

        return sessionId;
    }

    /// @notice Funds an existing session with USDC.
    function fundSession(uint256 sessionId, uint96 amount) external {
        Session storage session = _sessions[sessionId];

        if (session.owner == address(0)) revert SessionNotFound();
        if (msg.sender != session.owner) revert NotOwner();
        if (session.closed) revert SessionAlreadyClosed();
        if (block.timestamp > session.expiresAt) revert SessionExpired();
        if (amount == 0) revert ZeroAmount();

        uint96 newTotalFunded = session.totalFunded + amount;
        if (newTotalFunded > session.maxBudget) revert BudgetExceeded();

        session.totalFunded = newTotalFunded;

        emit SessionFunded(sessionId, msg.sender, amount, newTotalFunded);

        USDC_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Settles a request payment to the session provider using an EIP-712 quote signature.
    /// @dev Recipient is always session.provider.
    function payForRequest(
        uint256 sessionId,
        bytes32 requestId,
        bytes32 requestHash,
        uint96 amount,
        uint64 quoteDeadline,
        bytes calldata providerSignature
    ) external nonReentrant {
        Session storage session = _sessions[sessionId];

        if (session.owner == address(0)) revert SessionNotFound();
        if (msg.sender != session.agent) revert NotAgent();
        if (session.closed) revert SessionAlreadyClosed();
        if (block.timestamp > session.expiresAt) revert SessionExpired();
        if (amount == 0) revert ZeroAmount();
        if (amount > session.perPaymentCap) revert PerPaymentCapExceeded();

        uint96 newTotalSpent = session.totalSpent + amount;
        if (newTotalSpent > session.totalFunded) revert FundedBudgetExceeded();
        if (newTotalSpent > session.maxBudget) revert LifetimeBudgetExceeded();

        if (block.timestamp > quoteDeadline) revert QuoteExpired();
        if (quoteDeadline > session.expiresAt) revert QuoteDeadlineExceedsSession();
        if (_requestPaid[sessionId][requestId]) revert RequestAlreadyPaid();

        bytes32 structHash = keccak256(
            abi.encode(_PAYMENT_QUOTE_TYPEHASH, sessionId, requestId, requestHash, uint256(amount), quoteDeadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredSigner = ECDSA.recover(digest, providerSignature);
        if (recoveredSigner != session.quoteSigner) revert InvalidSignature();

        _requestPaid[sessionId][requestId] = true;
        session.totalSpent = newTotalSpent;

        emit PaymentSettled(sessionId, requestId, session.provider, requestHash, msg.sender, amount, quoteDeadline);

        USDC_TOKEN.safeTransfer(session.provider, amount);
    }

    /// @notice Closes a session permanently and refunds any unspent funded USDC to the session owner.
    /// @dev Callable even after expiry.
    function closeSession(uint256 sessionId) external nonReentrant {
        Session storage session = _sessions[sessionId];

        if (session.owner == address(0)) revert SessionNotFound();
        if (msg.sender != session.owner) revert NotOwner();
        if (session.closed) revert SessionAlreadyClosed();

        session.closed = true;
        uint96 refund = session.totalFunded - session.totalSpent;

        emit SessionClosed(sessionId, msg.sender, refund, session.totalSpent);

        if (refund > 0) {
            USDC_TOKEN.safeTransfer(session.owner, refund);
        }
    }

    /// @notice Returns the session record; zero-values indicate non-existent session (owner == address(0)).
    function getSession(uint256 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice Returns remaining budget currently available for payout.
    /// @dev Returns 0 for non-existent or closed sessions.
    function availableBalance(uint256 sessionId) external view returns (uint96) {
        Session storage session = _sessions[sessionId];
        if (session.owner == address(0) || session.closed) {
            return 0;
        }
        return session.totalFunded - session.totalSpent;
    }

    /// @notice Returns a paginated slice of session IDs created by `owner`.
    /// @dev If `offset` is out of range (>= count), returns an empty array.
    function sessionIdsByOwner(address owner, uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 count = _ownerSessions[owner].length;
        if (offset >= count) {
            return new uint256[](0);
        }

        uint256 remaining = count - offset;
        uint256 length = limit < remaining ? limit : remaining;
        ids = new uint256[](length);

        for (uint256 i = 0; i < length; ++i) {
            ids[i] = _ownerSessions[owner][offset + i];
        }

        return ids;
    }

    /// @notice Returns the number of sessions created by `owner`.
    function ownerSessionCount(address owner) external view returns (uint256) {
        return _ownerSessions[owner].length;
    }
}
