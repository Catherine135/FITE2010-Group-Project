// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ElevatorOption.sol";

/// @notice Factory contract for creating and indexing elevator waiting-time options.
/// @dev The factory deployer acts as oracle by default; can be extended to multi-oracle design.
contract ElevatorOptionFactory {
    address public immutable token; // PrintToken contract address

    // Admin roles
    address public admin;
    address public pendingAdmin;

    // Creation fee and accumulated fees
    uint256 public createFeeWei;
    uint256 public accruedFees;

    // Rate limit: minimum interval between creations per address
    uint256 public minCreateInterval;
    mapping(address => uint256) public lastCreateAt;

    // Parameter bounds
    uint256 public minDuration;
    uint256 public maxDuration;
    uint256 public minPremium;
    uint256 public maxPremium;
    uint256 public minCollateral;
    uint256 public maxCollateral;
    uint256 public minStrikeTime;
    uint256 public maxStrikeTime;

    // Track all created option instances
    address[] public allOptions;
    mapping(address => address[]) private optionsByWriter;

    event OptionCreated(address indexed option, address indexed writer, uint8 optionType, uint256 strikeTime, uint256 premium, uint256 collateral, uint256 expiry);
    event AdminTransferStarted(address indexed oldAdmin, address indexed newAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event RulesUpdated(
        uint256 createFeeWei,
        uint256 minCreateInterval,
        uint256 minDuration,
        uint256 maxDuration,
        uint256 minPremium,
        uint256 maxPremium,
        uint256 minCollateral,
        uint256 maxCollateral,
        uint256 minStrikeTime,
        uint256 maxStrikeTime
    );
    event FeesWithdrawn(address indexed to, uint256 amount);
    event ActualTimeRelayed(address indexed option, uint256 actualTime);

    modifier onlyAdmin() {
        require(msg.sender == admin, "only admin");
        _;
    }

    constructor(address _token) {
        require(_token != address(0), "token zero");
        token = _token;
        admin = msg.sender;

        // Default risk-control parameters
        createFeeWei = 0;
        minCreateInterval = 0;
        minDuration = 5 minutes;
        maxDuration = 30 days;
        minPremium = 1e18;
        maxPremium = 1_000e18;
        minCollateral = 1e18;
        maxCollateral = 10_000e18;
        minStrikeTime = 1;
        maxStrikeTime = 240;
    }

    /// @notice Admin updates rule parameters.
    function setRules(
        uint256 _createFeeWei,
        uint256 _minCreateInterval,
        uint256 _minDuration,
        uint256 _maxDuration,
        uint256 _minPremium,
        uint256 _maxPremium,
        uint256 _minCollateral,
        uint256 _maxCollateral,
        uint256 _minStrikeTime,
        uint256 _maxStrikeTime
    ) external onlyAdmin {
        require(_minDuration <= _maxDuration, "duration range");
        require(_minPremium <= _maxPremium, "premium range");
        require(_minCollateral <= _maxCollateral, "collateral range");
        require(_minStrikeTime <= _maxStrikeTime, "strike range");

        createFeeWei = _createFeeWei;
        minCreateInterval = _minCreateInterval;
        minDuration = _minDuration;
        maxDuration = _maxDuration;
        minPremium = _minPremium;
        maxPremium = _maxPremium;
        minCollateral = _minCollateral;
        maxCollateral = _maxCollateral;
        minStrikeTime = _minStrikeTime;
        maxStrikeTime = _maxStrikeTime;

        emit RulesUpdated(
            _createFeeWei,
            _minCreateInterval,
            _minDuration,
            _maxDuration,
            _minPremium,
            _maxPremium,
            _minCollateral,
            _maxCollateral,
            _minStrikeTime,
            _maxStrikeTime
        );
    }

    /// @notice Creates a new elevator waiting-time option.
    /// @param _strikeTime Strike threshold in minutes.
    /// @param _premium Premium amount in PU.
    /// @param _collateralAmount Collateral amount in PU.
    /// @param _duration Seconds until expiry.
    /// @param _type 0=CALL,1=PUT
    function createOption(
        uint256 _strikeTime,
        uint256 _premium,
        uint256 _collateralAmount,
        uint256 _duration,
        uint8 _type
    ) external payable returns (address optionAddr) {
        require(_type <= uint8(ElevatorOption.OptionType.PUT), "invalid type");
        require(msg.value == createFeeWei, "wrong create fee");
        require(block.timestamp >= lastCreateAt[msg.sender] + minCreateInterval, "rate limited");
        require(_duration >= minDuration && _duration <= maxDuration, "bad duration");
        require(_premium >= minPremium && _premium <= maxPremium, "bad premium");
        require(_collateralAmount >= minCollateral && _collateralAmount <= maxCollateral, "bad collateral");
        require(_strikeTime >= minStrikeTime && _strikeTime <= maxStrikeTime, "bad strike");
        require(_premium < _collateralAmount, "premium must be < collateral");

        lastCreateAt[msg.sender] = block.timestamp;
        accruedFees += msg.value;

        ElevatorOption.OptionType optType = ElevatorOption.OptionType(_type);

        ElevatorOption option = new ElevatorOption(
            token,
            msg.sender,
            admin,
            address(this),
            _strikeTime,
            _premium,
            _collateralAmount,
            _duration,
            optType
        );

        optionAddr = address(option);
        allOptions.push(optionAddr);
        optionsByWriter[msg.sender].push(optionAddr);

        emit OptionCreated(optionAddr, msg.sender, _type, _strikeTime, _premium, _collateralAmount, block.timestamp + _duration);
    }

    /// @notice Withdraws accumulated creation fees.
    function withdrawFees(address payable to, uint256 amount) external onlyAdmin {
        require(to != address(0), "to zero");
        require(amount <= accruedFees, "exceed accrued");
        accruedFees -= amount;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw fail");
        emit FeesWithdrawn(to, amount);
    }

    /// @notice Initiates admin transfer.
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "new admin zero");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Pending admin confirms transfer.
    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "not pending admin");
        address old = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(old, admin);
    }

    /// @notice Returns a paginated list of all options.
    function getAllOptionsBatch(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = allOptions.length;
        if (offset >= n || limit == 0) {
            return new address[](0);
        }

        uint256 end = offset + limit;
        if (end > n) {
            end = n;
        }

        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = allOptions[i];
        }
    }

    /// @notice Returns a paginated list of options for a writer.
    function getWriterOptionsBatch(address writer, uint256 offset, uint256 limit) external view returns (address[] memory out) {
        address[] storage arr = optionsByWriter[writer];
        uint256 n = arr.length;
        if (offset >= n || limit == 0) {
            return new address[](0);
        }

        uint256 end = offset + limit;
        if (end > n) {
            end = n;
        }

        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = arr[i];
        }
    }

    function allOptionsLength() external view returns (uint256) {
        return allOptions.length;
    }

    function writerOptionsLength(address writer) external view returns (uint256) {
        return optionsByWriter[writer].length;
    }

    /// @notice Relays actual waiting-time recording through factory (matches Option onlyOracle check).
    function relayRecordActualTime(address optionAddr, uint256 actualTime) external onlyAdmin {
        ElevatorOption(optionAddr).recordActualTime(actualTime);
        emit ActualTimeRelayed(optionAddr, actualTime);
    }

    /// @notice Relays oracle change through factory admin.
    function relayChangeOracle(address optionAddr, address newOracle) external onlyAdmin {
        ElevatorOption(optionAddr).changeOracle(newOracle);
    }

    /// @notice Returns the full list of option addresses.
    function getAllOptions() external view returns (address[] memory) {
        return allOptions;
    }
}
