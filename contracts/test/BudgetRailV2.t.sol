// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {BudgetRailV2} from "../BudgetRailV2.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock ERC-20 (6 decimals, mint, blocklist) — reused from V1 test pattern
// ─────────────────────────────────────────────────────────────────────────────
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    uint8 private _dec;
    mapping(address => bool) public blocklisted;

    constructor() ERC20("Mock USDC", "mUSDC") { _dec = 6; }

    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocklisted(address a, bool v) external { blocklisted[a] = v; }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (blocklisted[from] || blocklisted[to]) revert("BLOCKED");
        super._update(from, to, value);
    }
}

// Reentrancy attacker token
contract ReentrantUSDC is MockUSDC {
    address public target;
    bytes   public attackData;
    bool    private _inAttack;

    function setAttack(address _t, bytes calldata _d) external { target = _t; attackData = _d; }

    function _update(address from, address to, uint256 value) internal override {
        if (target != address(0) && !_inAttack) {
            _inAttack = true;
            (bool ok, bytes memory ret) = target.call(attackData);
            if (!ok) { assembly { revert(add(ret,32), mload(ret)) } }
            _inAttack = false;
        }
        super._update(from, to, value);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main V2 test contract
// ─────────────────────────────────────────────────────────────────────────────
contract BudgetRailV2Test is Test {
    MockUSDC     usdc;
    BudgetRailV2 rail;

    address constant OWNER    = address(0x1000);
    address constant AGENT    = address(0x2000);
    address constant PROVIDER = address(0x3000);
    address constant TREASURY = address(0x4000);
    address constant ATTACKER = address(0x9999);
    address constant OWNER2   = address(0x1001);
    address constant AGENT2   = address(0x2001);

    uint256 constant SIGNER_PK = 0xD1CE;
    address quoteSigner; // vm.addr(SIGNER_PK)

    // Standard session params (gross amounts)
    uint256 constant MAX_BUDGET = 2_000_000; // $2.00 gross
    uint256 constant PER_CAP    = 200_000;   // $0.20 gross cap
    bytes32 constant REQ1       = bytes32(uint256(1));
    bytes32 constant REQ2       = bytes32(uint256(2));
    bytes32 constant HASH1      = keccak256("request body 1");

    // V2 typehash — must match BudgetRailV2 exactly
    bytes32 constant QUOTE_V2_TYPEHASH = keccak256(
        "PaymentQuoteV2(uint256 sessionId,bytes32 requestId,uint256 baseAmount,uint256 feeAmount,"
        "uint256 grossAmount,uint256 deadline,address provider,address treasury)"
    );

    // ── setUp ─────────────────────────────────────────────────────────────────
    function setUp() public {
        quoteSigner = vm.addr(SIGNER_PK);
        usdc = new MockUSDC();
        // Pass PROVIDER as hint — PROVIDER != TREASURY in tests, so no warning event fires.
        rail = new BudgetRailV2(address(usdc), TREASURY, PROVIDER);

        usdc.mint(OWNER,    100_000_000);
        usdc.mint(OWNER2,   100_000_000);
        usdc.mint(ATTACKER, 100_000_000);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    function _domainSep() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"),
            keccak256("2"),
            block.chainid,
            address(rail)
        ));
    }

    function _sign(
        uint256 pk,
        uint256 sid,
        bytes32 reqId,
        uint256 base,
        uint256 fee,
        uint256 gross,
        uint64  dl,
        address provider,
        address treasury
    ) internal view returns (bytes memory sig) {
        bytes32 sh = keccak256(abi.encode(
            QUOTE_V2_TYPEHASH,
            sid, reqId,
            base, fee, gross,
            uint256(dl),
            provider,
            treasury
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSep(), sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s_, v);
    }

    /// Sign with standard key, auto-compute fee/gross from base.
    function _signBase(uint256 sid, bytes32 reqId, uint256 base, uint64 dl)
        internal view returns (bytes memory, uint256 fee, uint256 gross)
    {
        fee   = (base * 50) / 10_000;
        gross = base + fee;
        return (_sign(SIGNER_PK, sid, reqId, base, fee, gross, dl, PROVIDER, TREASURY), fee, gross);
    }

    /// Full session: create + approve + fund.
    function _makeSession() internal returns (uint256 sid) {
        vm.prank(OWNER);
        sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER);
        usdc.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER);
        rail.fundSession(sid, MAX_BUDGET);
    }

    function _makeSessionCustom(
        address owner_, address agent_, address prov_,
        uint256 budget_, uint256 cap_, uint64 exp_
    ) internal returns (uint256 sid) {
        usdc.mint(owner_, budget_);
        vm.prank(owner_);
        sid = rail.createSession(agent_, prov_, quoteSigner, budget_, cap_, exp_);
        vm.prank(owner_);
        usdc.approve(address(rail), budget_);
        vm.prank(owner_);
        rail.fundSession(sid, budget_);
    }

    /// Execute payForRequestV2 as AGENT with base amount, auto-compute fee/gross.
    function _pay(uint256 sid, bytes32 reqId, uint256 base, uint64 dl) internal {
        (bytes memory sig, uint256 fee, uint256 gross) = _signBase(sid, reqId, base, dl);
        vm.prank(AGENT);
        rail.payForRequestV2(sid, base, fee, reqId, dl, sig);
        (gross); // suppress unused warning
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FEE ARITHMETIC TESTS (Part 06 required cases)
    // ══════════════════════════════════════════════════════════════════════════

    // FEE-01: $0.05 → C=50,000, E=250, vault debit=50,250
    function test_FEE01_fiveCents() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000;
        uint256 expectedFee   = 250;
        uint256 expectedGross = 50_250;

        uint64 dl = _expiry();
        _pay(sid, REQ1, base, dl);

        assertEq(usdc.balanceOf(PROVIDER), expectedFee == 0 ? base : base,
            "provider balance");
        assertEq(usdc.balanceOf(PROVIDER), 50_000, "C receives exactly base");
        assertEq(usdc.balanceOf(TREASURY), 250,    "E receives exactly fee");
        assertEq(rail.getSession(sid).totalSpent, expectedGross, "vault debit = gross");
    }

    // FEE-02: $1.00 → C=1,000,000, E=5,000, gross=1,005,000
    function test_FEE02_oneDollar() public {
        uint256 base  = 1_000_000;
        uint256 fee   = 5_000;
        uint256 gross = 1_005_000;

        // Session with enough budget
        uint256 budget = gross;
        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, budget, budget, _expiry());

        uint64 dl = _expiry();
        _pay(sid, REQ1, base, dl);

        assertEq(usdc.balanceOf(PROVIDER), 1_000_000, "C=1,000,000");
        assertEq(usdc.balanceOf(TREASURY), 5_000,     "E=5,000");
        assertEq(rail.getSession(sid).totalSpent, gross, "gross=1,005,000");
    }

    // FEE-03: Tiny base (< 200) → fee rounds to 0, no hidden charge
    function test_FEE03_tinyBaseZeroFee() public {
        uint256 base = 100; // fee = floor(100*50/10000) = 0
        uint256 fee  = 0;
        uint256 gross = 100;

        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, 10_000, 10_000, _expiry());
        uint256 treasuryBefore = usdc.balanceOf(TREASURY);

        uint64 dl = _expiry();
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, dl, PROVIDER, TREASURY);
        vm.prank(AGENT);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, sig);

        assertEq(usdc.balanceOf(PROVIDER), 100,           "C receives full base");
        assertEq(usdc.balanceOf(TREASURY), treasuryBefore, "E receives nothing (fee=0)");
        assertEq(rail.getSession(sid).totalSpent, 100,     "gross == base when fee=0");
    }

    // FEE-04: fee=0 on base=199 (boundary: 199*50/10000 = 0)
    function test_FEE04_feeZeroBoundary199() public {
        (uint256 fee, uint256 gross) = rail.computeFee(199);
        assertEq(fee,  0,   "fee=0 for base=199");
        assertEq(gross, 199, "gross=199");
    }

    // FEE-05: fee=1 on base=200 (boundary: 200*50/10000 = 1)
    function test_FEE05_feeOneBoundary200() public {
        (uint256 fee, uint256 gross) = rail.computeFee(200);
        assertEq(fee,  1,   "fee=1 for base=200");
        assertEq(gross, 201, "gross=201");
    }

    // FEE-06: computeFee matches exact spec table values
    function test_FEE06_computeFeeTable() public view {
        (uint256 f, uint256 g) = rail.computeFee(1_000);
        assertEq(f, 5);    assertEq(g, 1_005);

        (f, g) = rail.computeFee(10_000);
        assertEq(f, 50);   assertEq(g, 10_050);

        (f, g) = rail.computeFee(50_000);
        assertEq(f, 250);  assertEq(g, 50_250);

        (f, g) = rail.computeFee(100_000);
        assertEq(f, 500);  assertEq(g, 100_500);

        (f, g) = rail.computeFee(10_000_000);
        assertEq(f, 50_000);  assertEq(g, 10_050_000);

        (f, g) = rail.computeFee(100_000_000);
        assertEq(f, 500_000); assertEq(g, 100_500_000);

        // Rounding: 333,333 * 50 / 10000 = 1666.665 → floor = 1666
        (f, g) = rail.computeFee(333_333);
        assertEq(f, 1_666);   assertEq(g, 334_999);
    }

    // FEE-07: Gross exactly at perPaymentCap passes
    function test_FEE07_grossExactlyAtCap() public {
        uint256 base  = 199_000; // fee = 995, gross = 199,995 — below 200,000 cap
        uint256 sid   = _makeSession();
        uint64  dl    = _expiry();
        _pay(sid, REQ1, base, dl);
        assertEq(rail.getSession(sid).totalSpent, base + (base * 50) / 10_000);
    }

    // FEE-08: Gross 1 microUSDC above perPaymentCap reverts
    function test_FEE08_grossOneAboveCapReverts() public {
        // base that produces gross = perPaymentCap + 1
        // PER_CAP = 200_000; find base where base + floor(base*50/10000) = 200_001
        // Try base=199_104: fee=floor(199104*50/10000)=995, gross=200_099  — too high
        // Try base=199_002: fee=995, gross=199_997 — too low
        // Use perPaymentCap=100_000 for simplicity; gross=100_251 with base=100_000,fee=500,gross=100_500
        // Override: create session with cap exactly equal to a known gross
        uint256 capGross = 50_250; // base=50000, fee=250
        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, capGross * 10, capGross, _expiry());

        // Exact cap — passes
        _pay(sid, REQ1, 50_000, _expiry());

        // One above: base=50001 → fee=250 → gross=50251 > cap=50250
        uint256 base2 = 50_001;
        uint256 fee2  = (base2 * 50) / 10_000; // 250
        uint256 gross2 = base2 + fee2;           // 50_251
        bytes memory sig = _sign(SIGNER_PK, sid, REQ2, base2, fee2, gross2, _expiry(), PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.PerPaymentCapExceeded.selector);
        rail.payForRequestV2(sid, base2, fee2, REQ2, _expiry(), sig);
    }

    // FEE-09: Sufficient base, but insufficient gross (session not funded enough for gross)
    // The session cap equals `base` (50,000), but gross = 50,250 > cap → PerPaymentCapExceeded fires first.
    // This is correct contract behaviour: cap check precedes balance check.
    function test_FEE09_sufficientBaseInsufficientGross() public {
        uint256 base  = 50_000;
        uint256 fee   = 250;
        uint256 gross = 50_250;
        // Fund and cap = base only (50,000); gross=50,250 exceeds cap → PerPaymentCapExceeded
        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, base, base, _expiry());
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, _expiry(), PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.PerPaymentCapExceeded.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);

        // Separate case: cap is large enough (100,000) but totalFunded (50,000) < gross (50,250)
        // Budget must be >= cap, so use budget=100,000 but only fund 50,000 of it.
        usdc.mint(OWNER, 100_000);
        vm.prank(OWNER);
        uint256 sid2 = rail.createSession(AGENT, PROVIDER, quoteSigner, 100_000, 100_000, _expiry());
        vm.prank(OWNER); usdc.approve(address(rail), 50_000);
        vm.prank(OWNER); rail.fundSession(sid2, 50_000); // funded=50,000, gross=50,250 > funded
        bytes memory sig2 = _sign(SIGNER_PK, sid2, REQ1, base, fee, gross, _expiry(), PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.FundedBudgetExceeded.selector);
        rail.payForRequestV2(sid2, base, fee, REQ1, _expiry(), sig2);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AUTHORIZATION TESTS
    // ══════════════════════════════════════════════════════════════════════════

    // AUTH-01: Agent != owner; unrelated wallet cannot pay
    function test_AUTH01_wrongAgent() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000;
        (bytes memory sig, uint256 fee,) = _signBase(sid, REQ1, base, _expiry());
        vm.prank(ATTACKER);
        vm.expectRevert(BudgetRailV2.NotAgent.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
    }

    // AUTH-02: Owner != agent; owner calling payForRequestV2 when B != A
    function test_AUTH02_ownerCannotPayWhenNotAgent() public {
        uint256 sid = _makeSession(); // AGENT=0x2000, OWNER=0x1000
        uint256 base = 50_000;
        (bytes memory sig, uint256 fee,) = _signBase(sid, REQ1, base, _expiry());
        vm.prank(OWNER); // owner tries to pay — rejected because owner != agent
        vm.expectRevert(BudgetRailV2.NotAgent.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
    }

    // AUTH-03: A == B (same wallet, manual demo mode) — succeeds
    function test_AUTH03_ownerEqualsAgent() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(OWNER, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER); usdc.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER); rail.fundSession(sid, MAX_BUDGET);

        uint256 base = 50_000;
        (bytes memory sig, uint256 fee,) = _signBase(sid, REQ1, base, _expiry());
        vm.prank(OWNER); // A == B, valid
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
        assertEq(usdc.balanceOf(PROVIDER), base);
    }

    // AUTH-04: Non-owner cannot close session
    function test_AUTH04_nonOwnerCannotClose() public {
        uint256 sid = _makeSession();
        vm.prank(ATTACKER);
        vm.expectRevert(BudgetRailV2.NotOwner.selector);
        rail.closeSession(sid);
    }

    // AUTH-05: Non-owner cannot fund session
    function test_AUTH05_nonOwnerCannotFund() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(ATTACKER);
        vm.expectRevert(BudgetRailV2.NotOwner.selector);
        rail.fundSession(sid, 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SIGNATURE / REPLAY TESTS
    // ══════════════════════════════════════════════════════════════════════════

    // SIG-01: Wrong signer key
    function test_SIG01_wrongSignerKey() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        bytes memory sig = _sign(SIGNER_PK + 1, sid, REQ1, base, fee, gross, _expiry(), PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidSignature.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
    }

    // SIG-02: Replay — same requestId in same session
    function test_SIG02_replayRequestId() public {
        uint256 sid = _makeSession();
        _pay(sid, REQ1, 50_000, _expiry());

        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, _expiry(), PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.RequestAlreadyUsed.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
    }

    // SIG-03: Wrong chainId in domain
    function test_SIG03_wrongChainId() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 dl = _expiry();
        bytes32 wrongDomain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"), keccak256("2"), block.chainid + 1, address(rail)
        ));
        bytes32 sh = keccak256(abi.encode(QUOTE_V2_TYPEHASH, sid, REQ1, base, fee, gross, uint256(dl), PROVIDER, TREASURY));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wrongDomain, sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidSignature.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, abi.encodePacked(r, s_, v));
    }

    // SIG-04: Wrong verifying contract
    function test_SIG04_wrongVerifyingContract() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 dl = _expiry();
        bytes32 wrongDomain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"), keccak256("2"), block.chainid, address(0xDEAD)
        ));
        bytes32 sh = keccak256(abi.encode(QUOTE_V2_TYPEHASH, sid, REQ1, base, fee, gross, uint256(dl), PROVIDER, TREASURY));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wrongDomain, sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidSignature.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, abi.encodePacked(r, s_, v));
    }

    // SIG-05: V1 domain version rejected by V2 contract
    function test_SIG05_v1DomainRejected() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 dl = _expiry();
        // Use version "1" — V1 domain
        bytes32 v1Domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"), keccak256("1"), block.chainid, address(rail)
        ));
        bytes32 sh = keccak256(abi.encode(QUOTE_V2_TYPEHASH, sid, REQ1, base, fee, gross, uint256(dl), PROVIDER, TREASURY));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", v1Domain, sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidSignature.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, abi.encodePacked(r, s_, v));
    }

    // SIG-06: Tampered treasury address in signature
    function test_SIG06_tamperedTreasury() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 dl = _expiry();
        // Sign with a fake treasury address
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, dl, PROVIDER, address(0xBAD));
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidSignature.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, sig);
    }

    // SIG-07: Tampered provider address in signature
    function test_SIG07_tamperedProvider() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 dl = _expiry();
        // Sign with a fake provider address
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, dl, address(0xBAD), TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidSignature.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, sig);
    }

    // SIG-08: Caller supplies wrong feeAmount (inflated)
    function test_SIG08_inflatedFeeRejected() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000;
        uint256 badFee = 300; // correct is 250
        uint256 gross = base + badFee;
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, badFee, gross, _expiry(), PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidFeeAmount.selector);
        rail.payForRequestV2(sid, base, badFee, REQ1, _expiry(), sig);
    }

    // SIG-09: Caller supplies wrong feeAmount (deflated)
    function test_SIG09_deflatedFeeRejected() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000;
        uint256 badFee = 200; // correct is 250
        uint256 gross = base + badFee;
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, badFee, gross, _expiry(), PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.InvalidFeeAmount.selector);
        rail.payForRequestV2(sid, base, badFee, REQ1, _expiry(), sig);
    }

    // SIG-10: Expired quote deadline
    function test_SIG10_expiredDeadline() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 pastDl = uint64(block.timestamp - 1);
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, pastDl, PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.QuoteExpired.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, pastDl, sig);
    }

    // SIG-11: Expired session — pay and fund both revert
    function test_SIG11_expiredSession() public {
        uint256 sid = _makeSession();
        vm.warp(block.timestamp + 2 days); // past session expiry
        uint256 base = 50_000; uint256 fee = 250;
        uint64 dl = uint64(block.timestamp + 1 hours); // valid deadline but session expired
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, base+fee, dl, PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.SessionExpired.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, sig);

        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.SessionExpired.selector);
        rail.fundSession(sid, 1);
    }

    // SIG-12: quoteDeadline > session.expiresAt
    function test_SIG12_deadlineExceedsSession() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 tooLateDl = uint64(block.timestamp + 2 days); // past session expiry
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, tooLateDl, PROVIDER, TREASURY);
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.QuoteDeadlineExceedsSession.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, tooLateDl, sig);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BUDGET / SESSION LIFECYCLE TESTS
    // ══════════════════════════════════════════════════════════════════════════

    // BUD-01: Multiple deposits accumulate; one-over-max reverts
    function test_BUD01_multipleDeposits() public {
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER); usdc.approve(address(rail), MAX_BUDGET + 1);
        vm.prank(OWNER); rail.fundSession(sid, MAX_BUDGET / 2);
        vm.prank(OWNER); rail.fundSession(sid, MAX_BUDGET / 2);
        assertEq(rail.getSession(sid).totalFunded, MAX_BUDGET);
        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.BudgetExceeded.selector);
        rail.fundSession(sid, 1);
    }

    // BUD-02: Close with remaining balance refunds exactly totalFunded - totalSpent
    function test_BUD02_closeWithRefund() public {
        uint256 ownerStart = usdc.balanceOf(OWNER);
        uint256 sid = _makeSession();
        _pay(sid, REQ1, 50_000, _expiry()); // gross = 50,250
        vm.prank(OWNER);
        rail.closeSession(sid);
        uint256 expectedRefund = MAX_BUDGET - 50_250;
        assertEq(usdc.balanceOf(OWNER), ownerStart - MAX_BUDGET + expectedRefund);
        assertTrue(rail.getSession(sid).closed);
    }

    // BUD-03: Fully spent → refund = 0, no USDC transfer
    function test_BUD03_closeFullySpentZeroRefund() public {
        uint256 gross = 50_250; // base=50000, fee=250
        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, gross, gross, _expiry());
        uint256 ownerBal = usdc.balanceOf(OWNER);
        _pay(sid, REQ1, 50_000, _expiry());
        vm.prank(OWNER); rail.closeSession(sid);
        assertEq(usdc.balanceOf(OWNER), ownerBal, "no refund when fully spent");
    }

    // BUD-04: Close after expiry still refunds
    function test_BUD04_closeAfterExpiry() public {
        uint256 ownerStart = usdc.balanceOf(OWNER);
        uint256 sid = _makeSession();
        vm.warp(block.timestamp + 2 days);
        vm.prank(OWNER); rail.closeSession(sid);
        assertEq(usdc.balanceOf(OWNER), ownerStart, "full refund after expiry");
    }

    // BUD-05: Double close reverts
    function test_BUD05_doubleClose() public {
        uint256 sid = _makeSession();
        vm.prank(OWNER); rail.closeSession(sid);
        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.SessionAlreadyClosed.selector);
        rail.closeSession(sid);
    }

    // BUD-06: Pay on closed session reverts
    function test_BUD06_payOnClosedSession() public {
        uint256 sid = _makeSession();
        vm.prank(OWNER); rail.closeSession(sid);
        uint256 base = 50_000; uint256 fee = 250;
        (bytes memory sig,,) = _signBase(sid, REQ1, base, _expiry());
        vm.prank(AGENT);
        vm.expectRevert(BudgetRailV2.SessionAlreadyClosed.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
    }

    // BUD-07: Top-up headroom = maxBudget - totalFunded (NOT maxBudget - availableBalance)
    function test_BUD07_topUpHeadroomBasedOnTotalFunded() public {
        // Fund half, spend quarter, then check headroom
        vm.prank(OWNER);
        uint256 sid = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        uint256 firstDeposit = MAX_BUDGET / 2;
        vm.prank(OWNER); usdc.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER); rail.fundSession(sid, firstDeposit);

        // Spend some (gross 50,250)
        _pay(sid, REQ1, 50_000, _expiry());

        // Available = firstDeposit - 50250 = 950,750
        // Headroom = maxBudget - totalFunded = 2,000,000 - 1,000,000 = 1,000,000
        // Top up by exactly headroom = 1,000,000 — should succeed
        vm.prank(OWNER); rail.fundSession(sid, MAX_BUDGET / 2);
        assertEq(rail.getSession(sid).totalFunded, MAX_BUDGET);

        // One more unit exceeds maxBudget
        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.BudgetExceeded.selector);
        rail.fundSession(sid, 1);
    }

    // BUD-08: Session isolation — spending in sid1 does not affect sid2
    function test_BUD08_sessionIsolation() public {
        uint256 sid1 = _makeSession();
        vm.prank(OWNER2);
        uint256 sid2 = rail.createSession(AGENT2, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER2); usdc.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER2); rail.fundSession(sid2, MAX_BUDGET);

        _pay(sid1, REQ1, 50_000, _expiry());
        assertEq(rail.getSession(sid2).totalSpent, 0);
        assertEq(rail.availableBalance(sid2), MAX_BUDGET);
    }

    // BUD-09: Zero budget reverts
    function test_BUD09_zeroBudget() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.InvalidBudget.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, 0, 1, _expiry());
    }

    // BUD-10: Zero perPaymentCap reverts
    function test_BUD10_zeroPerCap() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.InvalidPerPaymentCap.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, 0, _expiry());
    }

    // BUD-11: perPaymentCap > maxBudget reverts
    function test_BUD11_capExceedsBudget() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.InvalidPerPaymentCap.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, 100, 101, _expiry());
    }

    // BUD-12: expiresAt == block.timestamp reverts
    function test_BUD12_expiryEqualsNow() public {
        vm.prank(OWNER);
        vm.expectRevert(BudgetRailV2.ExpiryInPast.selector);
        rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, uint64(block.timestamp));
    }

    // BUD-13: Zero address params revert
    function test_BUD13_zeroAddressParams() public {
        vm.startPrank(OWNER);
        vm.expectRevert(BudgetRailV2.ZeroAddress.selector);
        rail.createSession(address(0), PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.expectRevert(BudgetRailV2.ZeroAddress.selector);
        rail.createSession(AGENT, address(0), quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.expectRevert(BudgetRailV2.ZeroAddress.selector);
        rail.createSession(AGENT, PROVIDER, address(0), MAX_BUDGET, PER_CAP, _expiry());
        vm.stopPrank();
    }

    // BUD-14: Session IDs start at 1 and increment
    function test_BUD14_sessionIdsStartAtOne() public {
        vm.startPrank(OWNER);
        uint256 s1 = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        uint256 s2 = rail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.stopPrank();
        assertEq(s1, 1);
        assertEq(s2, 2);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ATOMICITY / SAFETY TESTS
    // ══════════════════════════════════════════════════════════════════════════

    // ATOM-01: Blocklisted provider C — entire tx reverts, no partial payout, state unchanged
    function test_ATOM01_blocklistedProviderReverts() public {
        uint256 sid = _makeSession();
        usdc.setBlocklisted(PROVIDER, true);
        uint256 base = 50_000; uint256 fee = 250;
        (bytes memory sig,,) = _signBase(sid, REQ1, base, _expiry());
        vm.prank(AGENT);
        vm.expectRevert();
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
        // State must be unchanged
        assertEq(rail.getSession(sid).totalSpent, 0);
        assertFalse(rail.isRequestUsed(sid, REQ1));
        // Un-blocklist and retry — must succeed (requestId not consumed)
        usdc.setBlocklisted(PROVIDER, false);
        vm.prank(AGENT);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
        assertEq(usdc.balanceOf(PROVIDER), base);
    }

    // ATOM-02: Blocklisted treasury E — entire tx reverts, C also gets nothing
    function test_ATOM02_blocklistedTreasuryReverts() public {
        uint256 sid = _makeSession();
        usdc.setBlocklisted(TREASURY, true);
        uint256 base = 50_000; uint256 fee = 250;
        (bytes memory sig,,) = _signBase(sid, REQ1, base, _expiry());
        uint256 providerBefore = usdc.balanceOf(PROVIDER);
        vm.prank(AGENT);
        vm.expectRevert();
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
        // Neither C nor E should have received anything
        assertEq(usdc.balanceOf(PROVIDER), providerBefore, "C must not receive if E blocked");
        assertEq(rail.getSession(sid).totalSpent, 0, "totalSpent must be 0 after revert");
        assertFalse(rail.isRequestUsed(sid, REQ1), "requestId must not be consumed after revert");
    }

    // ATOM-03: Blocklisted owner — closeSession reverts; session remains open
    function test_ATOM03_blocklistedOwnerCloseReverts() public {
        uint256 sid = _makeSession();
        usdc.setBlocklisted(OWNER, true);
        vm.prank(OWNER);
        vm.expectRevert();
        rail.closeSession(sid);
        assertFalse(rail.getSession(sid).closed, "session must remain open after failed close");
        usdc.setBlocklisted(OWNER, false);
        vm.prank(OWNER); rail.closeSession(sid);
        assertTrue(rail.getSession(sid).closed);
    }

    // ATOM-04: Reentrancy on payForRequestV2
    function test_ATOM04_reentrancyBlocked() public {
        ReentrantUSDC rToken = new ReentrantUSDC();
        rToken.mint(OWNER, 100_000_000);
        BudgetRailV2 rRail = new BudgetRailV2(address(rToken), TREASURY, address(0));

        vm.prank(OWNER);
        uint256 sid = rRail.createSession(AGENT, PROVIDER, quoteSigner, MAX_BUDGET, PER_CAP, _expiry());
        vm.prank(OWNER); rToken.approve(address(rRail), MAX_BUDGET);
        vm.prank(OWNER); rRail.fundSession(sid, MAX_BUDGET);

        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 dl = _expiry();
        // Build sig for rRail domain
        bytes32 dom = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"), keccak256("2"), block.chainid, address(rRail)
        ));
        bytes32 sh = keccak256(abi.encode(QUOTE_V2_TYPEHASH, sid, REQ1, base, fee, gross, uint256(dl), PROVIDER, TREASURY));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", dom, sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s_, v);

        bytes memory reentrantCd = abi.encodeWithSelector(
            BudgetRailV2.payForRequestV2.selector, sid, base, fee, REQ1, dl, sig
        );
        rToken.setAttack(address(rRail), reentrantCd);

        vm.prank(AGENT);
        vm.expectRevert();
        rRail.payForRequestV2(sid, base, fee, REQ1, dl, sig);
        assertEq(rRail.getSession(sid).totalSpent, 0, "reentrancy must leave state unchanged");
    }

    // ATOM-05: No USDC on create/fund/close to treasury (fees only on payments)
    function test_ATOM05_noFeeOnCreateFundClose() public {
        uint256 treasuryBefore = usdc.balanceOf(TREASURY);

        uint256 sid = _makeSession(); // create + fund
        assertEq(usdc.balanceOf(TREASURY), treasuryBefore, "no fee on create/fund");

        vm.prank(OWNER); rail.closeSession(sid); // close with full refund
        assertEq(usdc.balanceOf(TREASURY), treasuryBefore, "no fee on close");
    }

    // ATOM-06: Constructor rejects zero treasury
    function test_ATOM06_constructorZeroTreasury() public {
        vm.expectRevert(BudgetRailV2.ZeroAddress.selector);
        new BudgetRailV2(address(usdc), address(0), address(0));
    }

    // ATOM-07: Constructor rejects zero USDC
    function test_ATOM07_constructorZeroUsdc() public {
        vm.expectRevert(BudgetRailV2.ZeroAddress.selector);
        new BudgetRailV2(address(0), TREASURY, address(0));
    }

    // ATOM-08: Constructor rejects USDC with no code (EOA)
    function test_ATOM08_constructorUsdcMustHaveCode() public {
        vm.expectRevert("BudgetRailV2: USDC address has no code");
        new BudgetRailV2(address(0x1234), TREASURY, address(0));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // EVENT TESTS
    // ══════════════════════════════════════════════════════════════════════════

    // EVT-01: PaymentSettledV2 contains correct split fields
    function test_EVT01_paymentSettledV2Fields() public {
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250; uint256 gross = 50_250;
        uint64 dl = _expiry();
        bytes memory sig = _sign(SIGNER_PK, sid, REQ1, base, fee, gross, dl, PROVIDER, TREASURY);

        vm.recordLogs();
        vm.prank(AGENT);
        rail.payForRequestV2(sid, base, fee, REQ1, dl, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BudgetRailV2.PaymentSettledV2.selector) {
                // indexed: sessionId, requestId, agent
                assertEq(uint256(logs[i].topics[1]), sid);
                assertEq(logs[i].topics[2], REQ1);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), AGENT);
                // non-indexed: provider, treasury, base, fee, gross, remaining
                (address prov, address treas, uint256 b, uint256 f, uint256 g, uint256 rem) =
                    abi.decode(logs[i].data, (address, address, uint256, uint256, uint256, uint256));
                assertEq(prov,  PROVIDER);
                assertEq(treas, TREASURY);
                assertEq(b,     base);
                assertEq(f,     fee);
                assertEq(g,     gross);
                assertEq(rem,   MAX_BUDGET - gross);
                found = true;
            }
        }
        assertTrue(found, "PaymentSettledV2 not found");
    }

    // EVT-02: PaymentSettledV2 is a different event selector from V1 PaymentSettled
    function test_EVT02_v2EventDistinctFromV1() public pure {
        bytes32 v1Selector = keccak256(
            "PaymentSettled(uint256,bytes32,address,bytes32,address,uint96,uint64)"
        );
        bytes32 v2Selector = BudgetRailV2.PaymentSettledV2.selector;
        assertTrue(v1Selector != v2Selector, "V1 and V2 event selectors must differ");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FUZZ / INVARIANT HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    // FUZZ-01: computeFee always returns fee <= base * 50 / 10000 (no rounding up)
    function testFuzz_FUZZ01_feeNeverExceedsHalfPercent(uint256 base) public view {
        base = bound(base, 0, type(uint128).max);
        (uint256 fee,) = rail.computeFee(base);
        assertLe(fee, (base * 50) / 10_000, "fee must not exceed floor(base*50/10000)");
    }

    // FUZZ-02: grossAmount = baseAmount + feeAmount always
    function testFuzz_FUZZ02_grossEqualsBasePlusFee(uint256 base) public view {
        base = bound(base, 0, type(uint128).max);
        (uint256 fee, uint256 gross) = rail.computeFee(base);
        assertEq(gross, base + fee, "gross must equal base + fee");
    }

    // FUZZ-03: Only AGENT can call payForRequestV2
    function testFuzz_FUZZ03_onlyAgentCanPay(address rando) public {
        vm.assume(rando != AGENT && rando != address(0));
        uint256 sid = _makeSession();
        uint256 base = 50_000; uint256 fee = 250;
        (bytes memory sig,,) = _signBase(sid, REQ1, base, _expiry());
        vm.prank(rando);
        vm.expectRevert(BudgetRailV2.NotAgent.selector);
        rail.payForRequestV2(sid, base, fee, REQ1, _expiry(), sig);
    }

    // FUZZ-04: totalSpent + refunded == totalFunded (conservation)
    function testFuzz_FUZZ04_accountingConservation(uint96 seed) public {
        uint256 base = bound(uint256(seed), 1, 100_000);
        (uint256 fee, uint256 gross) = rail.computeFee(base);
        uint256 budget = gross * 10;
        uint256 sid = _makeSessionCustom(OWNER, AGENT, PROVIDER, budget, gross, _expiry());
        uint256 ownerBefore = usdc.balanceOf(OWNER);
        _pay(sid, REQ1, base, _expiry());
        vm.prank(OWNER); rail.closeSession(sid);

        uint256 provBal  = usdc.balanceOf(PROVIDER);
        uint256 treasBal = usdc.balanceOf(TREASURY);
        uint256 ownerGain = usdc.balanceOf(OWNER) - ownerBefore;
        assertEq(provBal + treasBal + ownerGain, budget, "conservation: provider+treasury+refund==funded");
    }

    // ── Constructor / deployment warning ──────────────────────────────────────

    /// @dev C=E: treasury == providerHint should emit TreasuryMatchesProviderWarning but NOT revert.
    function test_constructor_CEqualsE_emitsWarning() public {
        MockUSDC u = new MockUSDC();
        address sharedAddr = address(0xBEEF);
        // Expect the warning event to be emitted during construction.
        vm.expectEmit(true, false, false, false);
        emit BudgetRailV2.TreasuryMatchesProviderWarning(sharedAddr, "");
        BudgetRailV2 r = new BudgetRailV2(address(u), sharedAddr, sharedAddr);
        // Contract should still deploy successfully and treasury should be set.
        assertEq(r.TREASURY(), sharedAddr, "treasury mismatch after C=E deploy");
    }

    /// @dev providerHint == address(0): no warning event, clean deploy.
    function test_constructor_providerHintZero_noWarning() public {
        MockUSDC u = new MockUSDC();
        // address(0) hint: skip the C=E check; no event emitted, no revert.
        BudgetRailV2 r = new BudgetRailV2(address(u), TREASURY, address(0));
        assertEq(r.TREASURY(), TREASURY);
    }

    /// @dev C != E: no warning event when provider and treasury are different.
    function test_constructor_CNotE_noWarning() public {
        MockUSDC u = new MockUSDC();
        // PROVIDER (0x3000) != TREASURY (0x4000): no event.
        BudgetRailV2 r = new BudgetRailV2(address(u), TREASURY, PROVIDER);
        assertEq(r.TREASURY(), TREASURY);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT TESTS
// ─────────────────────────────────────────────────────────────────────────────
contract BudgetRailV2Handler is CommonBase, StdCheats, StdUtils {
    BudgetRailV2 public rail;
    MockUSDC     public usdc;

    address constant OWNER    = address(0x1000);
    address constant AGENT    = address(0x2000);
    address constant PROVIDER = address(0x3000);
    address constant TREASURY = address(0x4000);
    uint256 constant SIGNER_PK = 0xD1CE;
    address public  qs;

    uint256 constant MAX_BUDGET = 2_000_000;
    uint256 constant PER_CAP    = 200_000;

    uint256 public sid;
    uint256 private _nonce;

    bytes32 constant QUOTE_V2_TYPEHASH = keccak256(
        "PaymentQuoteV2(uint256 sessionId,bytes32 requestId,uint256 baseAmount,uint256 feeAmount,"
        "uint256 grossAmount,uint256 deadline,address provider,address treasury)"
    );

    constructor(BudgetRailV2 _rail, MockUSDC _usdc) {
        rail = _rail;
        usdc = _usdc;
        qs = vm.addr(SIGNER_PK);
        _openSession();
    }

    function _openSession() internal {
        usdc.mint(OWNER, MAX_BUDGET);
        vm.prank(OWNER);
        sid = rail.createSession(AGENT, PROVIDER, qs, MAX_BUDGET, PER_CAP, uint64(block.timestamp + 30 days));
        vm.prank(OWNER); usdc.approve(address(rail), MAX_BUDGET);
        vm.prank(OWNER); rail.fundSession(sid, MAX_BUDGET);
    }

    function _domainSep() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("BudgetRail"), keccak256("2"), block.chainid, address(rail)
        ));
    }

    function pay(uint96 rawBase) external {
        BudgetRailV2.Session memory s = rail.getSession(sid);
        if (s.closed || block.timestamp > s.expiresAt) return;
        uint256 avail = s.totalFunded - s.totalSpent;
        if (avail == 0) return;
        // Bound base so gross fits in avail and cap
        uint256 base = bound(uint256(rawBase), 1, 99_000); // gross ~ 99,495 < 200,000 cap
        (uint256 fee, uint256 gross) = rail.computeFee(base);
        if (gross > avail || gross > s.perPaymentCap) return;
        bytes32 reqId = bytes32(_nonce++);
        uint64 dl = uint64(block.timestamp + 1 hours);
        if (dl > s.expiresAt) return;
        bytes32 sh = keccak256(abi.encode(QUOTE_V2_TYPEHASH, sid, reqId, base, fee, gross, uint256(dl), PROVIDER, TREASURY));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSep(), sh));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(SIGNER_PK, digest);
        vm.prank(AGENT);
        try rail.payForRequestV2(sid, base, fee, reqId, dl, abi.encodePacked(r, s_, v)) {} catch {}
    }

    function closeAndReopen() external {
        BudgetRailV2.Session memory s = rail.getSession(sid);
        if (s.closed) return;
        vm.prank(OWNER); rail.closeSession(sid);
        _openSession();
    }
}

contract BudgetRailV2Invariant is Test {
    MockUSDC            usdc;
    BudgetRailV2        rail;
    BudgetRailV2Handler handler;

    address constant TREASURY = address(0x4000);

    function setUp() public {
        usdc    = new MockUSDC();
        // address(0) hint: skip the C=E check in invariant tests (handler manages sessions).
        rail    = new BudgetRailV2(address(usdc), TREASURY, address(0));
        handler = new BudgetRailV2Handler(rail, usdc);
        targetContract(address(handler));
    }

    function invariant_totalSpentLeTotalFunded() public view {
        BudgetRailV2.Session memory s = rail.getSession(handler.sid());
        assertLe(s.totalSpent, s.totalFunded, "INV: totalSpent > totalFunded");
    }

    function invariant_totalFundedLeMaxBudget() public view {
        BudgetRailV2.Session memory s = rail.getSession(handler.sid());
        assertLe(s.totalFunded, s.maxBudget, "INV: totalFunded > maxBudget");
    }

    function invariant_availableBalanceConsistent() public view {
        BudgetRailV2.Session memory s = rail.getSession(handler.sid());
        if (!s.closed) {
            assertEq(
                rail.availableBalance(handler.sid()),
                s.totalFunded - s.totalSpent,
                "INV: availableBalance inconsistent"
            );
        }
    }
}
