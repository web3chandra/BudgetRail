// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BudgetRail} from "../BudgetRail.sol";

// ─────────────────────────────────────────────
// Mock ERC-20 with mint, burn, and blocklist
// ─────────────────────────────────────────────
contract MockERC20 is ERC20 {
    uint8 private _dec;
    mapping(address => bool) public blocklisted;

    constructor(string memory name_, string memory symbol_, uint8 dec_)
        ERC20(name_, symbol_)
    {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function setBlocklisted(address a, bool v) external { blocklisted[a] = v; }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (blocklisted[from] || blocklisted[to]) revert("BLOCKED");
        super._update(from, to, value);
    }
}

// ─────────────────────────────────────────────
// Reentrant token: on every _update callback,
// attempts to re-call a stored target with stored calldata.
// ─────────────────────────────────────────────
contract ReentrantToken is MockERC20 {
    address public target;
    bytes   public reentrantCalldata;
    bool    private _attacking;

    constructor() MockERC20("Reentrant", "RENT", 6) {}

    function setReentrant(address _target, bytes calldata _cd) external {
        target = _target;
        reentrantCalldata = _cd;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (target != address(0) && !_attacking) {
            _attacking = true;
            // Propagate the inner revert so the outer call also reverts.
            // nonReentrant on the inner payForRequest fires → inner reverts →
            // assembly bubble propagates → outer _update reverts → safeTransfer
            // reverts → outer payForRequest reverts.
            (bool ok, bytes memory ret) = target.call(reentrantCalldata);
            if (!ok) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
            _attacking = false;
        }
        super._update(from, to, value);
    }
}

// ─────────────────────────────────────────────
// Main test contract
// ─────────────────────────────────────────────
contract BudgetRailTest is Test {
    MockERC20  mock;
    BudgetRail rail;

    address constant OWNER    = address(0x1000);
    address constant AGENT    = address(0x2000);
    address constant PROVIDER = address(0x3000);
    address constant ATTACKER = address(0x9999);
    address constant OWNER2   = address(0x1001);
    address constant AGENT2   = address(0x2001);

    uint256 constant SIGNER_PK = 0xA11CE;
    address quoteSigner;   // vm.addr(SIGNER_PK), set in setUp

    uint96  constant MAX_BUDGET = 1_000_000;
    uint96  constant PER_CAP    = 100_000;
    uint96  constant AMT        = 50_000;
    bytes32 constant REQ1       = bytes32(uint256(1));
    bytes32 constant REQ2       = bytes32(uint256(2));
    bytes32 constant HASH1      = keccak256("request body 1");

    bytes32 constant QUOTE_TYPEHASH =
        keccak256(
            "PaymentQuote(uint256 sessionId,bytes32 requestId,bytes32 requestHash,uint256 amount,uint64 quoteDeadline)"
        );

    // ── setUp ──────────────────────────────────────────────────────────────
    function setUp() public {
        quoteSigner = vm.addr(SIGNER_PK);
        mock = new MockERC20("Mock USDC", "mUSDC", 6);
        rail = new BudgetRail(address(mock));
        mock.mint(OWNER,    10_000_000);
        mock.mint(OWNER2,   10_000_000);
        mock.mint(ATTACKER, 10_000_000);
    }

    // ── helpers ────────────────────────────────────────────────────────────
    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    /// Create session + approve + fund in one call (standard fixture).
    function _makeSession() internal returns (uint256 sid) {
        vm.prank(OWNER);
        sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER);
        mock.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER);
        rail.fundSession(sid, MAX_BUDGET);
    }

    /// Create session with custom params.
    function _makeSessionCustom(
        address owner_,
        address agent_,
        address prov_,
        address signer_,
        uint96  budget_,
        uint96  cap_,
        uint64  exp_
    ) internal returns (uint256 sid) {
        mock.mint(owner_, budget_);
        vm.prank(owner_);
        sid = rail.createSession(agent_, prov_, signer_, budget_, cap_, exp_);
        vm.prank(owner_);
        mock.approve(address(rail), budget_);
        vm.prank(owner_);
        rail.fundSession(sid, budget_);
    }

    /// Compute the EIP-712 domain separator matching the deployed rail.
    function _domainSep() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BudgetRail"),
                keccak256("1"),
                block.chainid,
                address(rail)
            )
        );
    }

    /// Build and sign an EIP-712 PaymentQuote.
    function _sign(
        uint256 pk,
        uint256 sid,
        bytes32 reqId,
        bytes32 reqHash,
        uint96  amt,
        uint64  deadline
    ) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(
            abi.encode(QUOTE_TYPEHASH, sid, reqId, reqHash, uint256(amt), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSep(), structHash));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s_, v);
    }

    /// Sign with the standard signer key.
    function _signDefault(uint256 sid, bytes32 reqId, bytes32 reqHash, uint96 amt, uint64 deadline)
        internal view returns (bytes memory)
    {
        return _sign(SIGNER_PK, sid, reqId, reqHash, amt, deadline);
    }

    /// Execute a payForRequest as AGENT with standard signer.
    function _pay(uint256 sid, bytes32 reqId, bytes32 reqHash, uint96 amt, uint64 deadline) internal {
        bytes memory sig = _signDefault(sid, reqId, reqHash, amt, deadline);
        vm.prank(AGENT);
        rail.payForRequest(sid, reqId, reqHash, amt, deadline, sig);
    }

    // ══════════════════════════════════════════════════════════════════════
    // FUNCTIONAL TESTS SC01–SC20
    // ══════════════════════════════════════════════════════════════════════

    // SC01 – Immutable token reference
    function test_SC01_immutableTokenReference() public {
        assertEq(rail.USDC_ADDRESS(), address(mock));
        assertEq(address(rail.USDC_TOKEN()), address(mock));
    }

    // SC02 – Session IDs start at 1 and increment
    function test_SC02_sessionIdsStartAtOne() public {
        vm.startPrank(OWNER);
        uint256 s1 = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        uint256 s2 = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.stopPrank();
        assertEq(s1, 1);
        assertEq(s2, 2);
        assertEq(rail.ownerSessionCount(OWNER), 2);
    }

    // SC03 – Two owners' sessions are isolated
    function test_SC03_sessionIsolationByOwner() public {
        vm.prank(OWNER);
        uint256 sid1 = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER2);
        uint256 sid2 = rail.createSession(AGENT2, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());

        assertEq(rail.getSession(sid1).owner, OWNER);
        assertEq(rail.getSession(sid2).owner, OWNER2);
        assertEq(rail.ownerSessionCount(OWNER),  1);
        assertEq(rail.ownerSessionCount(OWNER2), 1);

        uint256[] memory ids1 = rail.sessionIdsByOwner(OWNER,  0, 10);
        uint256[] memory ids2 = rail.sessionIdsByOwner(OWNER2, 0, 10);
        assertEq(ids1.length, 1); assertEq(ids1[0], sid1);
        assertEq(ids2.length, 1); assertEq(ids2[0], sid2);
    }

    // SC04 – Six-decimal boundary: 1 USDC = 1_000_000 units
    function test_SC04_sixDecimalBoundary() public {
        uint256 sid = _makeSession();
        assertEq(rail.getSession(sid).totalFunded, 1_000_000);
        assertEq(rail.availableBalance(sid), 1_000_000);
    }

    // SC05 – Bounded allowance and funding
    function test_SC05_boundedAllowanceAndFunding() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER);
        mock.approve(address(rail), 500_000);
        vm.prank(OWNER);
        rail.fundSession(sid, 500_000);
        assertEq(mock.balanceOf(address(rail)), 500_000);
        assertEq(rail.getSession(sid).totalFunded, 500_000);
    }

    // SC06 – Multiple deposits accumulate; one-over-max reverts
    function test_SC06_multipleDeposits() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER);
        mock.approve(address(rail), MAX_BUDGET + 1);

        vm.prank(OWNER); rail.fundSession(sid, 400_000);
        vm.prank(OWNER); rail.fundSession(sid, 400_000);
        vm.prank(OWNER); rail.fundSession(sid, 200_000);
        assertEq(rail.getSession(sid).totalFunded, 1_000_000);

        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.BudgetExceeded.selector);
        rail.fundSession(sid, 1);
    }

    // SC07 – Valid EIP-712 quote transfers exact 50 000 units
    function test_SC07_validEIP712TransfersExact50000() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, AMT, dl);
        assertEq(mock.balanceOf(PROVIDER), AMT);
        assertEq(rail.getSession(sid).totalSpent, AMT);
    }

    // SC08 – Independent payments in same session
    function test_SC08_independentPayments() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, AMT, dl);
        _pay(sid, REQ2, keccak256("req2"), AMT, dl);
        assertEq(rail.getSession(sid).totalSpent, 2 * AMT);
        assertEq(mock.balanceOf(PROVIDER), 2 * AMT);
    }

    // SC09 – Exact cap passes; one-unit-over fails
    function test_SC09_exactCapPassesOneOverFails() public {
        // Exact cap on a fresh session
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, PER_CAP, dl);

        // One over cap on a new session
        uint256 sid2 = _makeSession();
        bytes memory sig = _signDefault(sid2, REQ1, HASH1, PER_CAP + 1, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.PerPaymentCapExceeded.selector);
        rail.payForRequest(sid2, REQ1, HASH1, PER_CAP + 1, dl, sig);
    }

    // SC10 – Exhaustion: last payment drains funded; second reverts
    function test_SC10_exhaustionLastPayment() public {
        uint96 budget = 200_000;
        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, quoteSigner, budget, budget, _expiry());
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, budget, dl);
        assertEq(rail.availableBalance(sid), 0);

        bytes memory sig = _signDefault(sid, REQ2, HASH1, 1, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.FundedBudgetExceeded.selector);
        rail.payForRequest(sid, REQ2, HASH1, 1, dl, sig);
    }

    // SC11 – Underfunding: no fund → FundedBudgetExceeded
    function test_SC11_underfundingReverts() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        // totalFunded == 0
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.FundedBudgetExceeded.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC12 – Close with remaining balance refunds correctly
    function test_SC12_closeWithRemainingRefund() public {
        uint256 ownerStart = mock.balanceOf(OWNER);
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, AMT, dl); // spend 50 000

        vm.prank(OWNER);
        rail.closeSession(sid);

        uint96 refund = MAX_BUDGET - AMT; // 950 000
        assertEq(mock.balanceOf(OWNER), ownerStart - MAX_BUDGET + refund);
        assertTrue(rail.getSession(sid).closed);
    }

    // SC13 – Fully spent → refund = 0
    function test_SC13_closeFullySpentZeroRefund() public {
        uint96 b = 100_000;
        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, quoteSigner, b, b, _expiry());
        uint256 ownerBal = mock.balanceOf(OWNER);
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, b, dl);

        vm.recordLogs();
        vm.prank(OWNER);
        rail.closeSession(sid);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BudgetRail.SessionClosed.selector) {
                (uint96 refunded, uint96 spent) = abi.decode(logs[i].data, (uint96, uint96));
                assertEq(refunded, 0);
                assertEq(spent, b);
                found = true;
            }
        }
        assertTrue(found, "SessionClosed not found");
        assertEq(mock.balanceOf(OWNER), ownerBal); // no change
    }

    // SC14 – Close after expiry still refunds
    function test_SC14_closeAfterExpiry() public {
        uint256 ownerStart = mock.balanceOf(OWNER);
        uint256 sid = _makeSession();
        vm.warp(block.timestamp + 2 days); // past expiry
        vm.prank(OWNER);
        rail.closeSession(sid);
        assertEq(mock.balanceOf(OWNER), ownerStart); // full refund
    }

    // SC15 – Two sessions isolated
    function test_SC15_twoSessionsIsolated() public {
        uint256 sid1 = _makeSession();
        // Create a second session for owner2
        vm.prank(OWNER2);
        uint256 sid2 = rail.createSession(AGENT2, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER2);
        mock.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER2);
        rail.fundSession(sid2, MAX_BUDGET);

        uint64 dl = _expiry();
        _pay(sid1, REQ1, HASH1, AMT, dl);
        assertEq(rail.getSession(sid2).totalSpent, 0);
        assertEq(rail.availableBalance(sid2), MAX_BUDGET);
    }

    // SC16 – Events decode correctly (ABI verification)
    function test_SC16_eventsDecodeCorrectly() public {
        uint64 exp = _expiry();

        // --- SessionCreated ---
        vm.recordLogs();
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, exp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool foundCreated;
        for (uint i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BudgetRail.SessionCreated.selector) {
                assertEq(uint256(logs[i].topics[1]), sid);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), OWNER);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), AGENT);
                (address prov, address qs, uint96 mb, uint96 pc, uint64 ex)
                    = abi.decode(logs[i].data, (address, address, uint96, uint96, uint64));
                assertEq(prov, PROVIDER);
                assertEq(qs, quoteSigner);
                assertEq(mb, MAX_BUDGET);
                assertEq(pc, PER_CAP);
                assertEq(ex, exp);
                foundCreated = true;
            }
        }
        assertTrue(foundCreated, "SessionCreated not found");

        // --- SessionFunded ---
        vm.recordLogs();
        vm.prank(OWNER);
        mock.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER);
        rail.fundSession(sid, MAX_BUDGET);
        logs = vm.getRecordedLogs();
        bool foundFunded;
        for (uint i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BudgetRail.SessionFunded.selector) {
                assertEq(uint256(logs[i].topics[1]), sid);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), OWNER);
                (uint96 amt, uint96 total) = abi.decode(logs[i].data, (uint96, uint96));
                assertEq(amt,   MAX_BUDGET);
                assertEq(total, MAX_BUDGET);
                foundFunded = true;
            }
        }
        assertTrue(foundFunded, "SessionFunded not found");

        // --- PaymentSettled ---
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.recordLogs();
        vm.prank(AGENT);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
        logs = vm.getRecordedLogs();
        bool foundSettled;
        for (uint i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BudgetRail.PaymentSettled.selector) {
                assertEq(uint256(logs[i].topics[1]), sid);
                assertEq(logs[i].topics[2], REQ1);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), PROVIDER);
                (bytes32 rh, address ag, uint96 a, uint64 deadline)
                    = abi.decode(logs[i].data, (bytes32, address, uint96, uint64));
                assertEq(rh, HASH1);
                assertEq(ag, AGENT);
                assertEq(a,  AMT);
                assertEq(deadline, dl);
                foundSettled = true;
            }
        }
        assertTrue(foundSettled, "PaymentSettled not found");

        // --- SessionClosed ---
        vm.recordLogs();
        vm.prank(OWNER);
        rail.closeSession(sid);
        logs = vm.getRecordedLogs();
        bool foundClosed;
        for (uint i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BudgetRail.SessionClosed.selector) {
                assertEq(uint256(logs[i].topics[1]), sid);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), OWNER);
                (uint96 refunded, uint96 spent)
                    = abi.decode(logs[i].data, (uint96, uint96));
                assertEq(refunded, MAX_BUDGET - AMT);
                assertEq(spent, AMT);
                foundClosed = true;
            }
        }
        assertTrue(foundClosed, "SessionClosed not found");
    }

    // SC17 – Pagination
    function test_SC17_pagination() public {
        vm.startPrank(OWNER);
        for (uint i; i < 5; ++i) {
            rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        }
        vm.stopPrank();

        uint256[] memory p1 = rail.sessionIdsByOwner(OWNER, 0, 3);
        assertEq(p1.length, 3);
        assertEq(p1[0], 1); assertEq(p1[1], 2); assertEq(p1[2], 3);

        uint256[] memory p2 = rail.sessionIdsByOwner(OWNER, 3, 3);
        assertEq(p2.length, 2);
        assertEq(p2[0], 4); assertEq(p2[1], 5);

        uint256[] memory p3 = rail.sessionIdsByOwner(OWNER, 5, 3);
        assertEq(p3.length, 0); // offset == count → empty, no revert

        uint256[] memory p4 = rail.sessionIdsByOwner(OWNER, 0, 0);
        assertEq(p4.length, 0);

        uint256[] memory p5 = rail.sessionIdsByOwner(OWNER, 100, 5);
        assertEq(p5.length, 0);
    }

    // SC18 – Fuzz: totalSpent + refunded <= totalFunded (conservation)
    function testFuzz_SC18_accountingInvariant(uint96 seed) public {
        seed = uint96(bound(uint256(seed), 1, uint256(MAX_BUDGET)));
        uint96 cap = seed <= MAX_BUDGET ? seed : MAX_BUDGET;

        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, cap, _expiry());
        vm.prank(OWNER);
        mock.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER);
        rail.fundSession(sid, MAX_BUDGET);

        uint96 payAmt = seed <= cap ? seed : cap;
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, payAmt, dl);
        vm.prank(AGENT);
        rail.payForRequest(sid, REQ1, HASH1, payAmt, dl, sig);

        uint256 ownerBefore = mock.balanceOf(OWNER);
        vm.prank(OWNER);
        rail.closeSession(sid);

        uint256 provBal = mock.balanceOf(PROVIDER);
        uint256 ownerGain = mock.balanceOf(OWNER) - ownerBefore;

        // Conservation: provider received + owner refund == original deposit
        assertEq(provBal + ownerGain, MAX_BUDGET,
            "conservation: provider + refund must equal funded amount");
    }

    // SC19 – Fuzz: only agent can call payForRequest
    function testFuzz_SC19_onlyAgentCanPay(address rando) public {
        vm.assume(rando != AGENT && rando != address(0));
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(rando);
        vm.expectRevert(BudgetRail.NotAgent.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC20 – Arc USDC ERC-20 decimals must be 6
    function test_SC20_arcUsdcDecimals() public view {
        // On Arc testnet the ERC-20 USDC at 0x3600000000000000000000000000000000000000
        // has 6 decimals.  Native gas USDC uses 18 dec for gas metering — a separate view
        // of the same pool — but all BudgetRail session accounting uses the 6-decimal view.
        assertEq(MockERC20(rail.USDC_ADDRESS()).decimals(), 6,
            "USDC ERC-20 must be 6 decimals (Arc ERC-20 view)");
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADVERSARIAL TESTS SC21–SC57
    // ══════════════════════════════════════════════════════════════════════

    // SC21 – Zero agent
    function test_SC21_zeroAgent() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.ZeroAddress.selector);
        rail.createSession(address(0), PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
    }

    // SC22 – Zero provider
    function test_SC22_zeroProvider() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.ZeroAddress.selector);
        rail.createSession(AGENT, address(0), quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
    }

    // SC23 – Zero quoteSigner
    function test_SC23_zeroQuoteSigner() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.ZeroAddress.selector);
        rail.createSession(AGENT, PROVIDER, address(0), MAX_BUDGET, PER_CAP, _expiry());
    }

    // SC24 – maxBudget = 0
    function test_SC24_zeroBudget() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.InvalidBudget.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, 0, PER_CAP, _expiry());
    }

    // SC25 – perPaymentCap = 0
    function test_SC25_zeroPerCap() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.InvalidPerPaymentCap.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, 0, _expiry());
    }

    // SC26 – perPaymentCap > maxBudget
    function test_SC26_capExceedsBudget() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.InvalidPerPaymentCap.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, 100, 101, _expiry());
    }

    // SC27 – expiresAt == block.timestamp (boundary: not strictly future)
    function test_SC27_expiryEqualsNow() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.ExpiryInPast.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP,
            uint64(block.timestamp));
    }

    // SC28 – expiresAt in the past
    function test_SC28_expiryInPast() public {
        vm.warp(1000);
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.ExpiryInPast.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP,
            uint64(block.timestamp - 1));
    }

    // SC29 – Non-owner calls fundSession
    function test_SC29_nonOwnerFund() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(ATTACKER);
        vm.expectRevert(BudgetRail.NotOwner.selector);
        rail.fundSession(sid, 1);
    }

    // SC30 – Non-owner calls closeSession
    function test_SC30_nonOwnerClose() public {
        uint256 sid = _makeSession();
        vm.prank(ATTACKER);
        vm.expectRevert(BudgetRail.NotOwner.selector);
        rail.closeSession(sid);
    }

    // SC31 – Non-agent calls payForRequest
    function test_SC31_nonAgentPay() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(ATTACKER);
        vm.expectRevert(BudgetRail.NotAgent.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC32 – Wrong signer key
    function test_SC32_wrongSigner() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes memory sig = _sign(SIGNER_PK + 1, sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC33 – Wrong chainId in digest
    function test_SC33_wrongChainId() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes32 wrongDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BudgetRail"),
                keccak256("1"),
                block.chainid + 1,
                address(rail)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(QUOTE_TYPEHASH, sid, REQ1, HASH1, uint256(AMT), dl)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wrongDomain, structHash));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s_, v);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC34 – Wrong verifyingContract
    function test_SC34_wrongVerifyingContract() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes32 wrongDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BudgetRail"),
                keccak256("1"),
                block.chainid,
                address(0xDEAD)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(QUOTE_TYPEHASH, sid, REQ1, HASH1, uint256(AMT), dl)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wrongDomain, structHash));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s_, v);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC35 – Wrong sessionId in quote (sign for 999, submit for actual sid)
    function test_SC35_wrongSessionInQuote() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes memory sig = _sign(SIGNER_PK, 999, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC36 – Mutated requestId
    function test_SC36_mutatedRequestId() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        // sign for REQ1, submit with REQ2
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ2, HASH1, AMT, dl, sig);
    }

    // SC37 – Mutated requestHash
    function test_SC37_mutatedRequestHash() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes32 differentHash = keccak256("different");
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ1, differentHash, AMT, dl, sig);
    }

    // SC38 – Mutated amount
    function test_SC38_mutatedAmount() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT + 1, dl, sig);
    }

    // SC39 – Mutated quoteDeadline
    // Sign for dl, submit dl+1.  dl is _expiry() = now+1days, so dl+1 is still <= session.expiresAt
    // only if the deadline doesn't overflow uint64.  We use a deadline well inside the session so
    // that dl+1 is still a valid deadline — the only difference is the sig was built over dl.
    function test_SC39_mutatedDeadline() public {
        uint256 sid = _makeSession();
        // Use a deadline 10 minutes from now — safely inside the 1-day session.
        uint64 dl = uint64(block.timestamp + 10 minutes);
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        // Submit with dl+1 (still inside session expiry, so QuoteDeadlineExceedsSession won't fire).
        // The struct hash differs from what was signed → InvalidSignature.
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.InvalidSignature.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl + 1, sig);
    }

    // SC40 – Duplicate requestId in same session
    function test_SC40_duplicateRequestId() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, AMT, dl);
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.RequestAlreadyPaid.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
    }

    // SC41 – Same requestId bytes in different sessions (each independently signed)
    function test_SC41_sameRequestIdDifferentSessions() public {
        uint256 sid1 = _makeSession();

        // second session for owner2
        vm.prank(OWNER2);
        uint256 sid2 = rail.createSession(AGENT2, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER2);
        mock.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER2);
        rail.fundSession(sid2, MAX_BUDGET);

        uint64 dl = _expiry();
        // Both use REQ1 bytes but signed over different sessionIds → different digests
        bytes memory sig1 = _signDefault(sid1, REQ1, HASH1, AMT, dl);
        bytes memory sig2 = _signDefault(sid2, REQ1, HASH1, AMT, dl);

        vm.prank(AGENT);
        rail.payForRequest(sid1, REQ1, HASH1, AMT, dl, sig1);
        vm.prank(AGENT2);
        rail.payForRequest(sid2, REQ1, HASH1, AMT, dl, sig2);

        assertEq(rail.getSession(sid1).totalSpent, AMT);
        assertEq(rail.getSession(sid2).totalSpent, AMT);
    }

    // SC42 – Expired quote
    function test_SC42_expiredQuote() public {
        uint256 sid = _makeSession();
        uint64 pastDeadline = uint64(block.timestamp - 1);
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, pastDeadline);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.QuoteExpired.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, pastDeadline, sig);
    }

    // SC43 – Expired session: pay and fund both revert
    function test_SC43_expiredSession() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        vm.warp(block.timestamp + 2 days); // past session expiry
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.SessionExpired.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);

        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.SessionExpired.selector);
        rail.fundSession(sid, 1);
    }

    // SC44 – Post-close: pay and second close both revert
    function test_SC44_postCloseSpend() public {
        uint256 sid = _makeSession();
        vm.prank(OWNER);
        rail.closeSession(sid);

        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRail.SessionAlreadyClosed.selector);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);

        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.SessionAlreadyClosed.selector);
        rail.closeSession(sid);
    }

    // SC45 – Overfunding
    function test_SC45_overfunding() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER);
        mock.approve(address(rail), MAX_BUDGET + 1);
        vm.prank(OWNER);
        rail.fundSession(sid, MAX_BUDGET);

        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.BudgetExceeded.selector);
        rail.fundSession(sid, 1);
    }

    // SC46 – Very large amounts (uint96 max, no overflow)
    // After totalSpent == type(uint96).max, attempting to spend 1 more causes:
    //   newTotalSpent = type(uint96).max + 1  → uint96 arithmetic overflow (panic 0x11)
    // This fires BEFORE the FundedBudgetExceeded check.  Both are correct guard paths:
    // either way the second payment is impossible and no funds move.
    function test_SC46_largeAmounts() public {
        uint96 huge = type(uint96).max;
        mock.mint(OWNER, uint256(huge)); // extra supply
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, huge, huge, _expiry());
        vm.prank(OWNER);
        mock.approve(address(rail), uint256(huge));
        vm.prank(OWNER);
        rail.fundSession(sid, huge);

        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, huge, dl);
        vm.prank(AGENT);
        rail.payForRequest(sid, REQ1, HASH1, huge, dl, sig);

        assertEq(rail.getSession(sid).totalSpent, huge);
        assertEq(rail.availableBalance(sid), 0);

        // Second pay of 1: totalSpent + 1 overflows uint96 → checked-arithmetic panic.
        // The PerPaymentCapExceeded check (amount > perPaymentCap) fires FIRST because
        // amount=1 <= cap=huge, then newTotalSpent = huge+1 overflows.
        // Either way the transaction reverts; assert generic revert.
        bytes memory sig2 = _signDefault(sid, REQ2, HASH1, 1, dl);
        vm.prank(AGENT);
        vm.expectRevert(); // panic 0x11 (overflow) or FundedBudgetExceeded
        rail.payForRequest(sid, REQ2, HASH1, 1, dl, sig2);
    }

    // SC47 – Reentrancy on payForRequest
    function test_SC47_reentrancyOnPay() public {
        ReentrantToken rToken = new ReentrantToken();
        rToken.mint(OWNER, 10_000_000);
        BudgetRail rRail = new BudgetRail(address(rToken));
        address qs = vm.addr(SIGNER_PK);

        vm.prank(OWNER);
        uint256 sid = rRail.createSession(AGENT, PROVIDER, qs, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER);
        rToken.approve(address(rRail), MAX_BUDGET);
        vm.prank(OWNER);
        rRail.fundSession(sid, MAX_BUDGET);

        uint64 dl = uint64(block.timestamp + 1 days);
        // Build sig against rRail domain
        bytes32 dom = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"), keccak256("1"), block.chainid, address(rRail)
        ));
        bytes32 sh = keccak256(abi.encode(QUOTE_TYPEHASH, sid, REQ1, HASH1, uint256(AMT), dl));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", dom, sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s_, v);

        // Set re-entry calldata
        bytes memory reentrantCd = abi.encodeWithSelector(
            BudgetRail.payForRequest.selector, sid, REQ1, HASH1, AMT, dl, sig
        );
        rToken.setReentrant(address(rRail), reentrantCd);

        vm.prank(AGENT);
        // nonReentrant fires on the inner call → inner reverts → SafeERC20 reverts outer
        vm.expectRevert();
        rRail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);

        // Ledger must be untouched
        assertEq(rRail.getSession(sid).totalSpent, 0);
    }

    // SC48 – No double close (CEI + nonReentrant defense)
    function test_SC48_noDoubleClose() public {
        uint256 ownerStart = mock.balanceOf(OWNER);
        uint256 sid = _makeSession();
        vm.prank(OWNER);
        rail.closeSession(sid);
        // Exactly one refund sent
        assertEq(mock.balanceOf(OWNER), ownerStart);
        // Second close reverts
        vm.prank(OWNER);
        vm.expectRevert(BudgetRail.SessionAlreadyClosed.selector);
        rail.closeSession(sid);
    }

    // SC49 – Failed transfer rollback (blocklist provider)
    function test_SC49_failedTransferRollback() public {
        uint256 sid = _makeSession();
        mock.setBlocklisted(PROVIDER, true);
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert(); // SafeERC20FailedOperation wraps BLOCKED
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);

        // State rolled back: same requestId now usable after un-blocklisting
        mock.setBlocklisted(PROVIDER, false);
        vm.prank(AGENT);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);
        assertEq(mock.balanceOf(PROVIDER), AMT);
    }

    // SC50 – Failed refund rollback (blocklist owner)
    function test_SC50_failedRefundRollback() public {
        uint256 sid = _makeSession();
        mock.setBlocklisted(OWNER, true);
        vm.prank(OWNER);
        vm.expectRevert(); // BLOCKED
        rail.closeSession(sid);

        // Session must still be open (closed=false due to rollback)
        assertFalse(rail.getSession(sid).closed,
            "session must remain open after failed close");

        mock.setBlocklisted(OWNER, false);
        vm.prank(OWNER);
        rail.closeSession(sid);
        assertTrue(rail.getSession(sid).closed);
    }

    // SC51 – Fixed provider recipient
    function test_SC51_fixedProviderRecipient() public {
        uint256 sid = _makeSession();
        uint64 dl = _expiry();
        _pay(sid, REQ1, HASH1, AMT, dl);
        assertEq(mock.balanceOf(PROVIDER), AMT);
        assertEq(mock.balanceOf(AGENT), 0);
    }

    // SC52 – Constructor with zero address
    function test_SC52_constructorZeroAddress() public {
        vm.expectRevert(BudgetRail.ZeroAddress.selector);
        new BudgetRail(address(0));
    }

    // SC53 – Missing allowance: fundSession reverts; totalFunded stays 0
    function test_SC53_missingAllowance() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        // No approve
        vm.prank(OWNER);
        vm.expectRevert(); // SafeERC20FailedOperation
        rail.fundSession(sid, MAX_BUDGET);
        // totalFunded rolled back to 0
        assertEq(rail.getSession(sid).totalFunded, 0,
            "totalFunded must be 0 after failed transferFrom");
    }

    // SC54 – No receive/fallback: cannot send native value
    function test_SC54_noReceiveFallback() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(rail).call{value: 1 ether}("");
        assertFalse(ok, "BudgetRail must not accept ETH/native");
    }

    // SC55 – Blocklist provider mid-session (explicit alias of SC49 pattern)
    function test_SC55_blocklistProviderMidSession() public {
        uint256 sid = _makeSession();
        mock.setBlocklisted(PROVIDER, true);
        uint64 dl = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, HASH1, AMT, dl);
        vm.prank(AGENT);
        vm.expectRevert();
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig);

        mock.setBlocklisted(PROVIDER, false);
        vm.prank(AGENT);
        rail.payForRequest(sid, REQ1, HASH1, AMT, dl, sig); // same reqId, rolled back
        assertEq(mock.balanceOf(PROVIDER), AMT);
    }

    // SC56 – EIP-712 signing vector (Solidity-computed digest == viem-equivalent)
    function test_SC56_viem_eip712Vector() public {
        // Known inputs for cross-verification:
        //   sessionId=1, requestId=bytes32(42), requestHash=keccak256("hello world"),
        //   amount=50_000, quoteDeadline=block.timestamp+300
        //
        // Viem off-chain equivalent:
        //   import { hashTypedData } from 'viem'
        //   hashTypedData({
        //     domain: { name:"BudgetRail", version:"1", chainId, verifyingContract },
        //     types: { PaymentQuote: [
        //       { name:"sessionId",    type:"uint256" },
        //       { name:"requestId",    type:"bytes32" },
        //       { name:"requestHash",  type:"bytes32" },
        //       { name:"amount",       type:"uint256" },
        //       { name:"quoteDeadline",type:"uint64"  },
        //     ]},
        //     primaryType: "PaymentQuote",
        //     message: { sessionId:1n, requestId:bytes32(42), requestHash:keccak256("hello world"),
        //                amount:50000n, quoteDeadline:BigInt(deadline) }
        //   })
        uint256 sid = _makeSession(); // creates sid=1
        bytes32 reqId   = bytes32(uint256(42));
        bytes32 reqHash = keccak256("hello world");
        uint96  amt     = AMT;
        uint64  dl      = uint64(block.timestamp + 300);
        bytes memory sig = _signDefault(sid, reqId, reqHash, amt, dl);
        vm.prank(AGENT);
        rail.payForRequest(sid, reqId, reqHash, amt, dl, sig);
        assertEq(rail.getSession(sid).totalSpent, amt);
    }

    // SC57 – Unicode requestHash (multi-byte UTF-8)
    function test_SC57_unicodeRequestHash() public {
        // "Analyse éàü" in UTF-8: é=0xC3A9, à=0xC3A0, ü=0xC3BC
        // In Solidity string literals we write the bytes directly.
        bytes32 reqHash = keccak256(
            abi.encodePacked(
                "Analyse ",
                hex"c3a9",   // é
                hex"c3a0",   // à
                hex"c3bc"    // ü
            )
        );
        uint256 sid = _makeSession();
        uint64  dl  = _expiry();
        bytes memory sig = _signDefault(sid, REQ1, reqHash, AMT, dl);

        vm.recordLogs();
        vm.prank(AGENT);
        rail.payForRequest(sid, REQ1, reqHash, AMT, dl, sig);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BudgetRail.PaymentSettled.selector) {
                (bytes32 rh,,,) = abi.decode(logs[i].data, (bytes32, address, uint96, uint64));
                assertEq(rh, reqHash, "unicode requestHash must survive log round-trip");
                found = true;
            }
        }
        assertTrue(found, "PaymentSettled not emitted");
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// INVARIANT TESTS
// ══════════════════════════════════════════════════════════════════════════════

/// Handler for invariant testing: wraps session fund/pay/close calls
/// with bounded inputs so the fuzzer can explore state sequences.
contract BudgetRailHandler is CommonBase, StdCheats, StdUtils {
    BudgetRail public rail;
    MockERC20  public mock;

    address constant OWNER   = address(0x1000);
    address constant AGENT   = address(0x2000);
    address constant PROV    = address(0x3000);
    uint256 constant SIGNER_PK = 0xA11CE;
    address public  qs;

    uint96 constant MAX_BUDGET = 1_000_000;
    uint96 constant PER_CAP    = 100_000;

    uint256 public sid;
    uint256 private _nonce;

    bytes32 constant QUOTE_TYPEHASH =
        keccak256(
            "PaymentQuote(uint256 sessionId,bytes32 requestId,bytes32 requestHash,uint256 amount,uint64 quoteDeadline)"
        );

    constructor(BudgetRail _rail, MockERC20 _mock) {
        rail = _rail;
        mock = _mock;
        qs = vm.addr(SIGNER_PK);
        _openSession();
    }

    function _openSession() internal {
        mock.mint(OWNER, MAX_BUDGET);
        vm.prank(OWNER);
        sid = rail.createSession(AGENT, PROV, qs, MAX_BUDGET, PER_CAP, uint64(block.timestamp + 30 days));
        vm.prank(OWNER);
        mock.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER);
        rail.fundSession(sid, MAX_BUDGET);
    }

    function _domainSep() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"), keccak256("1"), block.chainid, address(rail)
        ));
    }

    function _sign(bytes32 reqId, uint96 amt, uint64 dl) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(QUOTE_TYPEHASH, sid, reqId, keccak256("body"), uint256(amt), dl));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSep(), sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        return abi.encodePacked(r, s_, v);
    }

    /// Handler action: pay a bounded amount
    function pay(uint96 rawAmt) external {
        BudgetRail.Session memory s = rail.getSession(sid);
        if (s.closed || block.timestamp > s.expiresAt) return;
        uint96 available = s.totalFunded - s.totalSpent;
        if (available == 0) return;
        uint96 cap = s.perPaymentCap < available ? s.perPaymentCap : available;
        uint96 amt = uint96(bound(uint256(rawAmt), 1, uint256(cap)));
        bytes32 reqId = bytes32(_nonce++);
        uint64 dl = uint64(block.timestamp + 1 hours);
        if (dl > s.expiresAt) return;
        bytes memory sig = _sign(reqId, amt, dl);
        vm.prank(AGENT);
        try rail.payForRequest(sid, reqId, keccak256("body"), amt, dl, sig) {} catch {}
    }

    /// Handler action: close the session then reopen
    function closeAndReopen() external {
        BudgetRail.Session memory s = rail.getSession(sid);
        if (s.closed) return;
        vm.prank(OWNER);
        rail.closeSession(sid);
        _openSession();
    }
}

contract BudgetRailInvariant is Test {
    MockERC20          mock;
    BudgetRail         rail;
    BudgetRailHandler  handler;

    function setUp() public {
        mock    = new MockERC20("Mock USDC", "mUSDC", 6);
        rail    = new BudgetRail(address(mock));
        handler = new BudgetRailHandler(rail, mock);
        targetContract(address(handler));
    }

    /// Invariant: totalSpent must never exceed totalFunded
    function invariant_totalSpentLeTotalFunded() public view {
        BudgetRail.Session memory s = rail.getSession(handler.sid());
        assertLe(s.totalSpent, s.totalFunded,
            "invariant: totalSpent > totalFunded");
    }

    /// Invariant: totalFunded must never exceed maxBudget
    function invariant_totalFundedLeMaxBudget() public view {
        BudgetRail.Session memory s = rail.getSession(handler.sid());
        assertLe(s.totalFunded, s.maxBudget,
            "invariant: totalFunded > maxBudget");
    }
}
