// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title BudgetRailV2
/// @notice Session-based USDC payment rail with atomic provider + platform fee split.
/// @dev
/// V2 adds an immutable platform fee (50 bps, 0.5%) on top of the provider's quoted base price.
/// On each successful payForRequestV2 call:
///   - Provider C receives exactly `baseAmount` (the quoted price).
///   - Treasury E receives exactly `feeAmount = floor(baseAmount * 50 / 10_000)`.
///   - Session totalSpent is debited by `grossAmount = baseAmount + feeAmount`.
///   - Both transfers are atomic; if either reverts, the entire transaction reverts.
///
/// Fee only applies to successful payForRequestV2. Create/fund/close/refund are fee-free.
///
/// Security notes (identical to V1 unless noted):
/// 1) Direct USDC transfers to this contract address are permanently locked (no sweep function).
///    Users MUST fund sessions exclusively via fundSession.
/// 2) Circle USDC may blocklist addresses. If C or E is blocklisted, payForRequestV2 reverts entirely.
///    If owner A is blocklisted, closeSession reverts. No fallback recipient.
/// 3) nonReentrant on payForRequestV2 and closeSession. Checks-effects-interactions ordering.
/// 4) Session expiry and quote deadlines use block.timestamp.
/// 5) V2 EIP-712 domain uses version "2" and this contract's address — V1 quotes are structurally
///    incompatible and will always fail ECDSA recovery.
///
/// Accounting invariants (per session, at all times):
///   totalSpent <= totalFunded <= maxBudget
///   availableBalance = totalFunded - totalSpent >= 0
///   On close: refund = totalFunded - totalSpent (exact, non-negative)
///
/// Fee invariant (per successful payForRequestV2):
///   feeAmount = floor(baseAmount * FEE_BPS / FEE_DENOMINATOR)
///   grossAmount = baseAmount + feeAmount
///   C receives baseAmount, E receives feeAmount, vault debited grossAmount
contract BudgetRailV2 is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────────

    /// @notice Platform fee in basis points. Exactly 50 bps = 0.5%. Immutable.
    uint256 public constant FEE_BPS = 50;

    /// @notice Denominator for fee calculation. 10_000 = 100%.
    uint256 public constant FEE_DENOMINATOR = 10_000;

    /// @notice Contract version string. Used in EIP-712 domain.
    string public constant VERSION = "2";

    // ── Immutables ───────────────────────────────────────────────────────────

    /// @notice USDC ERC-20 token contract.
    IERC20 public immutable USDC_TOKEN;

    /// @notice USDC ERC-20 token address. Readable without casting.
    address public immutable USDC_ADDRESS;

    /// @notice Platform treasury address (role E). Receives feeAmount on each settlement.
    /// Set at deploy, immutable. Must be nonzero and operator-verified before deploy.
    address public immutable TREASURY;

    // ── EIP-712 typehash ─────────────────────────────────────────────────────

    /// @dev V2 typehash. Distinct from V1 ("PaymentQuote") — cross-version replay is structurally impossible.
    bytes32 private constant _PAYMENT_QUOTE_V2_TYPEHASH = keccak256(
        "PaymentQuoteV2(uint256 sessionId,bytes32 requestId,uint256 baseAmount,uint256 feeAmount,"
        "uint256 grossAmount,uint256 deadline,address provider,address treasury)"
    );

    // ── Storage ──────────────────────────────────────────────────────────────

    struct Session {
        address owner;        // A — creates, funds, closes
        address agent;        // B — calls payForRequestV2
        address provider;     // C — receives baseAmount
        address quoteSigner;  // D — signs EIP-712 quotes
        uint256 maxBudget;    // gross cap (includes fees)
        uint256 perPaymentCap; // max grossAmount per single payment
        uint256 totalFunded;  // cumulative gross deposits
        uint256 totalSpent;   // cumulative grossAmount spent
        uint64  expiresAt;    // unix timestamp; session is inactive after this
        bool    closed;       // set true by closeSession; irreversible
    }

    /// @dev sessionId → Session. IDs start at 1 (auto-increment).
    mapping(uint256 => Session) private _sessions;

    /// @dev (sessionId, requestId) → paid marker. Prevents replay within a session.
    /// Note: requestId uniqueness is global per contract in V2 (stronger than V1's per-session).
    mapping(bytes32 => bool) private _usedRequestIds;

    /// @dev owner address → ordered list of session IDs.
    mapping(address => uint256[]) private _ownerSessions;

    /// @dev Monotonic counter; incremented before use so first ID is 1.
    uint256 private _nextSessionId;

    // ── Errors ───────────────────────────────────────────────────────────────

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
    error RequestAlreadyUsed();
    error InvalidSignature();
    error InvalidFeeAmount();
    error InvalidOffset();
    error TreasuryMismatch();

    // ── Events ───────────────────────────────────────────────────────────────

    event SessionCreated(
        uint256 indexed sessionId,
        address indexed owner,
        address indexed agent,
        address provider,
        address quoteSigner,
        uint256 maxBudget,
        uint256 perPaymentCap,
        uint64  expiresAt
    );

    event SessionFunded(
        uint256 indexed sessionId,
        address indexed funder,
        uint256 grossAmount,
        uint256 totalFunded
    );

    /// @notice Emitted on each successful payForRequestV2. Distinct from V1's PaymentSettled.
    /// Indexers MUST NOT conflate this event with V1's PaymentSettled.
    event PaymentSettledV2(
        uint256 indexed sessionId,
        bytes32 indexed requestId,
        address indexed agent,
        address provider,         // C — received baseAmount
        address treasury,         // E — received feeAmount
        uint256 baseAmount,       // provider earnings
        uint256 feeAmount,        // platform fee (may be 0 on micro-payments)
        uint256 grossAmount,      // baseAmount + feeAmount
        uint256 remainingBalance  // availableBalance after this payment
    );

    event SessionClosed(
        uint256 indexed sessionId,
        address indexed owner,
        uint256 refundAmount,
        uint256 totalSpent
    );

    // ── Constructor ──────────────────────────────────────────────────────────

    /// @param usdcAddress USDC ERC-20 contract address. Must have deployed code.
    /// @param treasury    Platform treasury address (role E). Nonzero; operator-verified before deploy.
    constructor(address usdcAddress, address treasury) EIP712("BudgetRail", VERSION) {
        if (usdcAddress == address(0)) revert ZeroAddress();
        if (treasury == address(0))    revert ZeroAddress();
        // Validate usdcAddress has code (not an EOA or empty address).
        uint256 codeSize;
        assembly { codeSize := extcodesize(usdcAddress) }
        require(codeSize > 0, "BudgetRailV2: USDC address has no code");

        USDC_TOKEN   = IERC20(usdcAddress);
        USDC_ADDRESS = usdcAddress;
        TREASURY     = treasury;
    }

    // ── Session lifecycle ────────────────────────────────────────────────────

    /// @notice Creates a new V2 payment session.
    /// @param agent        Role B: address authorized to call payForRequestV2.
    /// @param provider     Role C: address that receives baseAmount per payment.
    /// @param quoteSigner  Role D: address whose private key signs EIP-712 quotes.
    /// @param maxBudget    Gross lifetime cap (baseAmount + fee) for all payments in this session.
    /// @param perPaymentCap Max grossAmount for a single payment. Must be <= maxBudget.
    /// @param expiresAt    Unix timestamp after which the session is inactive. Must be strictly future.
    /// @return sessionId   Newly created session ID (starts at 1).
    function createSession(
        address agent,
        address provider,
        address quoteSigner,
        uint256 maxBudget,
        uint256 perPaymentCap,
        uint64  expiresAt
    ) external returns (uint256 sessionId) {
        if (agent == address(0) || provider == address(0) || quoteSigner == address(0))
            revert ZeroAddress();
        if (maxBudget == 0)
            revert InvalidBudget();
        if (perPaymentCap == 0 || perPaymentCap > maxBudget)
            revert InvalidPerPaymentCap();
        if (expiresAt <= block.timestamp)
            revert ExpiryInPast();

        unchecked { _nextSessionId += 1; }
        sessionId = _nextSessionId;

        _sessions[sessionId] = Session({
            owner:         msg.sender,
            agent:         agent,
            provider:      provider,
            quoteSigner:   quoteSigner,
            maxBudget:     maxBudget,
            perPaymentCap: perPaymentCap,
            totalFunded:   0,
            totalSpent:    0,
            expiresAt:     expiresAt,
            closed:        false
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
    }

    /// @notice Deposits USDC gross amount into an existing session.
    /// @dev    No platform fee on deposits. Amount must not push totalFunded past maxBudget.
    /// @param sessionId  Target session.
    /// @param amount     Gross USDC amount (6 decimals) to deposit.
    function fundSession(uint256 sessionId, uint256 amount) external {
        Session storage session = _sessions[sessionId];

        if (session.owner == address(0))   revert SessionNotFound();
        if (msg.sender != session.owner)   revert NotOwner();
        if (session.closed)                revert SessionAlreadyClosed();
        if (block.timestamp > session.expiresAt) revert SessionExpired();
        if (amount == 0)                   revert ZeroAmount();

        uint256 newTotalFunded = session.totalFunded + amount;
        if (newTotalFunded > session.maxBudget) revert BudgetExceeded();

        // Checks-effects-interactions: update state before external call.
        session.totalFunded = newTotalFunded;

        emit SessionFunded(sessionId, msg.sender, amount, newTotalFunded);

        USDC_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Settles a provider request payment with atomic base + fee split.
    /// @dev
    /// The contract independently computes `feeAmount = floor(baseAmount * 50 / 10_000)`.
    /// The caller-supplied `feeAmount` MUST match the contract's computation exactly;
    /// any discrepancy reverts with `InvalidFeeAmount`. This means the backend cannot
    /// inflate or deflate the fee — the contract is the source of truth.
    ///
    /// grossAmount = baseAmount + feeAmount. Both `perPaymentCap` and budget checks apply
    /// to grossAmount, not baseAmount. The session's `totalSpent` is debited by grossAmount.
    ///
    /// Atomicity: safeTransfer(C, baseAmount) then safeTransfer(E, feeAmount).
    /// If either reverts (e.g. USDC blocklist), the entire transaction reverts and no state changes.
    ///
    /// @param sessionId        Target session ID.
    /// @param baseAmount       Provider's base price. C receives this exactly.
    /// @param feeAmount        Platform fee. Must equal floor(baseAmount * 50 / 10_000). E receives this.
    /// @param requestId        Unique request identifier. Replaying a used requestId reverts.
    /// @param deadline         Quote expiry (unix timestamp). Must be >= block.timestamp and <= session.expiresAt.
    /// @param providerSignature EIP-712 signature by session.quoteSigner over PaymentQuoteV2 struct.
    function payForRequestV2(
        uint256 sessionId,
        uint256 baseAmount,
        uint256 feeAmount,
        bytes32 requestId,
        uint64  deadline,
        bytes calldata providerSignature
    ) external nonReentrant {
        Session storage session = _sessions[sessionId];

        // ── Authorization checks ──────────────────────────────────────────────
        if (session.owner == address(0))          revert SessionNotFound();
        if (msg.sender != session.agent)          revert NotAgent();
        if (session.closed)                       revert SessionAlreadyClosed();
        if (block.timestamp > session.expiresAt)  revert SessionExpired();
        if (baseAmount == 0)                      revert ZeroAmount();

        // ── Fee verification (contract is source of truth) ───────────────────
        uint256 expectedFee = (baseAmount * FEE_BPS) / FEE_DENOMINATOR;
        if (feeAmount != expectedFee)             revert InvalidFeeAmount();
        uint256 grossAmount = baseAmount + feeAmount;

        // ── Budget checks (all on grossAmount) ───────────────────────────────
        if (grossAmount > session.perPaymentCap)  revert PerPaymentCapExceeded();

        uint256 newTotalSpent = session.totalSpent + grossAmount;
        if (newTotalSpent > session.totalFunded)  revert FundedBudgetExceeded();
        if (newTotalSpent > session.maxBudget)    revert LifetimeBudgetExceeded();

        // ── Quote validity checks ─────────────────────────────────────────────
        if (block.timestamp > deadline)           revert QuoteExpired();
        if (deadline > session.expiresAt)         revert QuoteDeadlineExceedsSession();

        // ── Global requestId replay guard ─────────────────────────────────────
        // V2 uses a global (not per-session) uniqueness check for stronger protection.
        bytes32 globalReqKey = keccak256(abi.encodePacked(sessionId, requestId));
        if (_usedRequestIds[globalReqKey])        revert RequestAlreadyUsed();

        // ── EIP-712 signature verification ────────────────────────────────────
        // treasury must match TREASURY immutable; including it in the signed data
        // prevents a compromised backend from redirecting fees to a different address.
        bytes32 structHash = keccak256(abi.encode(
            _PAYMENT_QUOTE_V2_TYPEHASH,
            sessionId,
            requestId,
            baseAmount,
            feeAmount,
            grossAmount,
            uint256(deadline),
            session.provider,
            TREASURY
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredSigner = ECDSA.recover(digest, providerSignature);
        if (recoveredSigner != session.quoteSigner) revert InvalidSignature();

        // ── Checks-effects-interactions ───────────────────────────────────────
        _usedRequestIds[globalReqKey] = true;
        session.totalSpent = newTotalSpent;

        // Cache provider address before emitting to reduce stack depth.
        address provider_ = session.provider;
        uint256 remaining = session.totalFunded - newTotalSpent;

        emit PaymentSettledV2(
            sessionId,
            requestId,
            msg.sender,   // agent B
            provider_,
            TREASURY,
            baseAmount,
            feeAmount,
            grossAmount,
            remaining
        );

        // ── Atomic two-transfer payout ────────────────────────────────────────
        // Provider C receives base. If this reverts, everything reverts.
        USDC_TOKEN.safeTransfer(provider_, baseAmount);

        // Treasury E receives fee. Skip zero-transfer to avoid wasted gas on micro-payments,
        // but still emit the event above so dashboards can show fee=0 correctly.
        if (feeAmount > 0) {
            USDC_TOKEN.safeTransfer(TREASURY, feeAmount);
        }
    }

    /// @notice Closes a session permanently and refunds unspent funded USDC to session owner A.
    /// @dev
    /// Callable by owner A even after session expiry. No fee on refund.
    /// Refund = totalFunded - totalSpent (exact, non-negative by I-1 invariant).
    /// Refund of 0 is valid (fully spent session); no USDC transfer in that case.
    /// @param sessionId Target session to close.
    function closeSession(uint256 sessionId) external nonReentrant {
        Session storage session = _sessions[sessionId];

        if (session.owner == address(0)) revert SessionNotFound();
        if (msg.sender != session.owner) revert NotOwner();
        if (session.closed)              revert SessionAlreadyClosed();

        // Checks-effects-interactions: mark closed before any transfer.
        session.closed = true;
        uint256 refund = session.totalFunded - session.totalSpent;

        emit SessionClosed(sessionId, msg.sender, refund, session.totalSpent);

        if (refund > 0) {
            USDC_TOKEN.safeTransfer(session.owner, refund);
        }
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns the full session record. Zero owner indicates non-existent session.
    function getSession(uint256 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice Returns the gross USDC available for future payments in a session.
    /// @dev Returns 0 for non-existent or closed sessions.
    function availableBalance(uint256 sessionId) external view returns (uint256) {
        Session storage session = _sessions[sessionId];
        if (session.owner == address(0) || session.closed) return 0;
        return session.totalFunded - session.totalSpent;
    }

    /// @notice Computes the fee and gross for a given base amount. Pure — matches contract formula exactly.
    /// @return feeAmount   floor(baseAmount * 50 / 10_000)
    /// @return grossAmount baseAmount + feeAmount
    function computeFee(uint256 baseAmount)
        external
        pure
        returns (uint256 feeAmount, uint256 grossAmount)
    {
        feeAmount   = (baseAmount * FEE_BPS) / FEE_DENOMINATOR;
        grossAmount = baseAmount + feeAmount;
    }

    /// @notice Returns paginated session IDs created by `owner`.
    /// @dev Returns empty array when offset >= count (no revert).
    function sessionIdsByOwner(address owner, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids)
    {
        uint256 count = _ownerSessions[owner].length;
        if (offset >= count) return new uint256[](0);

        uint256 remaining = count - offset;
        uint256 length = limit < remaining ? limit : remaining;
        ids = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            ids[i] = _ownerSessions[owner][offset + i];
        }
    }

    /// @notice Returns the total number of sessions created by `owner`.
    function ownerSessionCount(address owner) external view returns (uint256) {
        return _ownerSessions[owner].length;
    }

    /// @notice Checks whether a requestId has been used (globally across all sessions).
    function isRequestUsed(uint256 sessionId, bytes32 requestId) external view returns (bool) {
        return _usedRequestIds[keccak256(abi.encodePacked(sessionId, requestId))];
    }
}
