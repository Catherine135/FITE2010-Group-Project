// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================================
//  ElevatorOption.sol  -- Part A (core contract security / cancellation logic)
// ============================================================================
//
//  High-level flow overview
//  ─────────────────────
//  1. Factory deploys this contract -> constructor validates parameter ranges
//  2. Writer  deposit()          -> lock PU collateral (with reentrancy guard)
//  3. Buyer   buyOption()        -> pay PU premium and activate option (with reentrancy guard)
//  4. Writer  cancelIfUnbought() -> refund collateral if unbought and close (Part A core requirement)
//  5. Anyone  cancelIfInactive() -> auto-cancel after inactive timeout (Part A extension)
//  6. Oracle/Relay changeOracle() -> update oracle address (Part A extension)
//  7. Oracle  recordActualTime() -> write actual waiting time after expiry
//  8. Buyer   exercise()         -> exercise and receive collateral (with reentrancy guard)
//  9. Writer  retrieveExpired()  -> reclaim collateral if not exercised after expiry (with reentrancy guard)
// ============================================================================

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ElevatorOption {

    // ===================== Enums & Constants =====================

    enum OptionType { CALL, PUT }

    // -- Parameter bounds (Part A: validation checks) --
    uint256 public constant MIN_STRIKE_TIME   = 1;        // Minimum strike threshold: 1 minute
    uint256 public constant MAX_STRIKE_TIME   = 1440;     // Maximum strike threshold: 1440 minutes (24h)
    uint256 public constant MIN_DURATION      = 60;       // Minimum duration: 60 seconds
    uint256 public constant MAX_DURATION      = 365 days; // Maximum duration: 1 year
    uint256 public constant MIN_COLLATERAL    = 1;        // Collateral must be > 0 (smallest unit)
    uint256 public constant INACTIVE_TIMEOUT  = 7 days;   // Inactive timeout threshold (Part A extension)

    // ===================== State Variables =====================

    IERC20     public immutable token;
    address    public immutable writer;
    uint256    public immutable strikeTime;       // Threshold in minutes
    uint256    public immutable premium;           // Premium in PU
    uint256    public immutable collateralAmount;  // Collateral in PU
    uint256    public immutable expiry;            // Expiry timestamp
    uint256    public immutable createdAt;         // Creation timestamp (used for inactive timeout cancel)
    OptionType public immutable optionType;

    address public oracle;          // Oracle address (updatable)
    address public immutable relayCaller; // Trusted relay caller (factory)
    address public buyer;
    bool    public isDeposited;
    bool    public isActive;        // Buyer has paid premium
    bool    public isExercised;
    bool    public isCanceled;      // Canceled (cancelIfUnbought / cancelIfInactive / retrieveExpired)

    uint256 public actualWaitTime;
    bool    public actualTimeRecorded;

    // -- Reentrancy lock (Part A: reentrancy protection) --
    bool private _locked;

    // ===================== Events =====================

    event Deposited(address indexed writer, uint256 amount);
    event OptionBought(address indexed buyer, uint256 premium);
    event CanceledUnbought(address indexed writer, uint256 returned);
    event CanceledInactive(address indexed caller, uint256 returned);
    event OracleChanged(address indexed oldOracle, address indexed newOracle);
    event ActualTimeRecorded(uint256 actualTime);
    event Exercised(address indexed buyer, uint256 payout);
    event Expired(address indexed writer, uint256 returned);

    // ===================== Modifiers =====================

    /// @dev Part A core requirement: protect against reentrancy as an extra layer beyond CEI.
    modifier nonReentrant() {
        require(!_locked, "ReentrancyGuard: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyWriter() {
        require(msg.sender == writer, "only writer");
        _;
    }

    modifier notCanceled() {
        require(!isCanceled, "option canceled");
        _;
    }

    // ===================== Constructor =====================

    /// @notice Deployed by Factory.
    /// @dev Part A core requirement: validate parameter bounds.
    ///      Flow: validate all inputs -> assign immutable state -> use independent oracle.
    constructor(
        address _token,
        address _writer,
        address _oracle,
        address _relayCaller,
        uint256 _strikeTime,
        uint256 _premium,
        uint256 _collateralAmount,
        uint256 _duration,
        OptionType _type
    ) {
        // -- Parameter validation (Part A: bounds checks) --
        require(_token  != address(0), "token zero addr");
        require(_writer != address(0), "writer zero addr");
        require(_oracle != address(0), "oracle zero addr");
        require(_relayCaller != address(0), "relay zero addr");
        require(_oracle != _writer, "oracle cannot be writer");
        require(_strikeTime >= MIN_STRIKE_TIME && _strikeTime <= MAX_STRIKE_TIME,
                "strikeTime out of range");
        require(_duration >= MIN_DURATION && _duration <= MAX_DURATION,
                "duration out of range");
        require(_collateralAmount >= MIN_COLLATERAL, "collateral too low");
        require(_premium > 0, "premium must be > 0");
        require(_premium < _collateralAmount, "premium must be < collateral");

        token            = IERC20(_token);
        writer           = _writer;
        strikeTime       = _strikeTime;
        premium          = _premium;
        collateralAmount = _collateralAmount;
        expiry           = block.timestamp + _duration;
        createdAt        = block.timestamp;
        optionType       = _type;

        // Use an independent oracle by default to avoid writer conflict of interest.
        oracle = _oracle;
        relayCaller = _relayCaller;
    }

    // ====================================================================
    //  Step 2 - Writer deposits collateral
    // ====================================================================
    /// @notice Writer transfers PU collateral into the contract.
    /// @dev Flow: role check -> not deposited -> not canceled -> not expired -> transferFrom -> mark deposited.
    function deposit() external onlyWriter notCanceled nonReentrant {
        require(!isDeposited, "already deposited");
        require(block.timestamp < expiry, "expired");

        bool ok = token.transferFrom(writer, address(this), collateralAmount);
        require(ok, "deposit transfer failed");

        isDeposited = true;
        emit Deposited(writer, collateralAmount);
    }

    // ====================================================================
    //  Step 3 - Buyer pays premium and activates option
    // ====================================================================
    /// @notice Buyer pays PU premium to activate the option.
    /// @dev Flow: collateral deposited -> inactive -> not canceled -> not expired -> transferFrom -> activate.
    function buyOption() external notCanceled nonReentrant {
        require(isDeposited, "not deposited yet");
        require(!isActive, "already active");
        require(block.timestamp < expiry, "expired");
        require(msg.sender != writer, "writer cannot buy own option");

        bool ok = token.transferFrom(msg.sender, writer, premium);
        require(ok, "premium transfer failed");

        buyer    = msg.sender;
        isActive = true;
        emit OptionBought(msg.sender, premium);
    }

    // ====================================================================
    //  Step 4 - cancelIfUnbought (Part A core requirement)
    // ====================================================================
    /// @notice Writer cancels an unbought option and reclaims collateral.
    /// @dev Part A core task: implement cancelIfUnbought.
    ///      Flow: only writer -> deposited -> unbought (!isActive) -> not canceled
    ///            -> set isCanceled = true first (CEI)
    ///            -> refund collateral.
    function cancelIfUnbought() external onlyWriter notCanceled nonReentrant {
        require(isDeposited, "nothing to cancel");
        require(!isActive, "already bought, cannot cancel");
        require(block.timestamp < expiry, "expired");

        // Checks-Effects-Interactions: update state before external transfer.
        isCanceled = true;

        bool ok = token.transfer(writer, collateralAmount);
        require(ok, "refund failed");

        emit CanceledUnbought(writer, collateralAmount);
    }

    // ====================================================================
    //  Step 5 - cancelIfInactive (Part A extension: inactive-timeout cancel)
    // ====================================================================
    /// @notice If the option remains unbought past INACTIVE_TIMEOUT, anyone can trigger cancel.
    /// @dev Part A extension: prevent collateral from being locked in ignored options.
    ///      Flow: deposited -> inactive -> timeout reached -> not canceled -> refund writer.
    function cancelIfInactive() external notCanceled nonReentrant {
        require(isDeposited, "nothing to cancel");
        require(!isActive, "already active");
        require(block.timestamp >= createdAt + INACTIVE_TIMEOUT, "timeout not reached");

        isCanceled = true;

        bool ok = token.transfer(writer, collateralAmount);
        require(ok, "refund failed");

        emit CanceledInactive(msg.sender, collateralAmount);
    }

    // ====================================================================
    //  Step 6 - changeOracle (Part A extension: oracle update)
    // ====================================================================
    /// @notice Current oracle (or trusted relay caller) can change oracle address before actual time is recorded.
    /// @dev Part A extension: avoid writer-controlled oracle changes.
    ///      Flow: only oracle/relay -> not recorded yet -> non-zero new address -> update.
    function changeOracle(address _newOracle) external {
        require(msg.sender == oracle || msg.sender == relayCaller, "only oracle");
        require(!actualTimeRecorded, "time already recorded");
        require(_newOracle != address(0), "oracle zero addr");
        require(_newOracle != writer, "oracle cannot be writer");
        require(_newOracle != buyer, "oracle cannot be buyer");

        address old = oracle;
        oracle = _newOracle;
        emit OracleChanged(old, _newOracle);
    }

    // ====================================================================
    //  Step 7 - Oracle records actual waiting time
    // ====================================================================
    /// @notice Oracle (or trusted relay caller) records actual elevator waiting time after expiry.
    /// @dev Flow: only oracle/relay -> active -> expired -> not recorded -> validate range -> write value.
    function recordActualTime(uint256 _actualTime) external {
        require(msg.sender == oracle || msg.sender == relayCaller, "only oracle");
        require(isActive, "not active");
        require(block.timestamp >= expiry, "not yet expired");
        require(!actualTimeRecorded, "already recorded");
        require(_actualTime <= MAX_STRIKE_TIME, "actualTime out of range");

        actualWaitTime     = _actualTime;
        actualTimeRecorded = true;
        emit ActualTimeRecorded(_actualTime);
    }

    // ====================================================================
    //  Step 8 - Buyer exercises
    // ====================================================================
    /// @notice Buyer exercises and receives collateral if conditions are met.
    /// @dev Flow: only buyer -> active -> not exercised -> not canceled -> oracle recorded
    ///      -> CALL: actual > strike | PUT: actual < strike -> transfer collateral.
    function exercise() external notCanceled nonReentrant {
        require(msg.sender == buyer, "only buyer");
        require(isActive, "not active");
        require(!isExercised, "already exercised");
        require(actualTimeRecorded, "time not recorded");

        if (optionType == OptionType.CALL) {
            require(actualWaitTime > strikeTime, "CALL: actual <= strike, cannot exercise");
        } else {
            require(actualWaitTime < strikeTime, "PUT: actual >= strike, cannot exercise");
        }

        // CEI: update state first.
        isExercised = true;

        bool ok = token.transfer(buyer, collateralAmount);
        require(ok, "payout failed");

        emit Exercised(buyer, collateralAmount);
    }

    // ====================================================================
    //  Step 9 - Writer retrieves collateral after expiry
    // ====================================================================
    /// @notice After expiry and without exercise, writer reclaims collateral.
    /// @dev Flow: only writer -> expired -> not exercised -> not canceled -> CEI -> refund.
    function retrieveExpired() external onlyWriter notCanceled nonReentrant {
        require(block.timestamp >= expiry, "not expired yet");
        require(!isExercised, "already exercised");
        if (isActive) {
            require(actualTimeRecorded, "time not recorded");
        }

        isCanceled = true;

        bool ok = token.transfer(writer, collateralAmount);
        require(ok, "return failed");

        emit Expired(writer, collateralAmount);
    }

    // ===================== View Helpers =====================

    /// @notice Returns current PU balance held by the contract.
    function contractBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Returns whether the option is still buyable.
    function isBuyable() external view returns (bool) {
        return isDeposited && !isActive && !isCanceled && block.timestamp < expiry;
    }
}
