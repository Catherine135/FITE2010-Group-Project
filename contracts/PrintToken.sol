// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PrintToken - basic ERC20 token representing Print Unit (PU)
contract PrintToken {
    // Basic metadata
    string public name = "Print Unit";
    string public symbol = "PU";
    uint8 public constant decimals = 18;

    // Total supply and account balances
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    // Allowances: owner => spender => amount
    mapping(address => mapping(address => uint256)) public allowance;

    // Contract owner for controlled administration
    address public owner;
    address public pendingOwner;

    // Mint permissions and quotas
    mapping(address => bool) public isMinter;
    mapping(address => uint256) public mintQuota;

    // One-time airdrop switch
    bool public oneTimeAirdropDone;

    // Events: transfer and approval
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferStarted(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event MinterUpdated(address indexed minter, bool enabled, uint256 quota);
    event OneTimeAirdropExecuted(uint256 recipients, uint256 totalAmount);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Internal mint function for controlled issuance.
    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "mint to zero");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Configures minter status and quota.
    function setMinter(address minter, bool enabled, uint256 quota) external onlyOwner {
        require(minter != address(0), "minter zero");
        isMinter[minter] = enabled;
        mintQuota[minter] = quota;
        emit MinterUpdated(minter, enabled, quota);
    }

    /// @notice Mint interface: owner is unlimited; minter is limited by quota.
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) {
            require(isMinter[msg.sender], "not minter");
            uint256 q = mintQuota[msg.sender];
            require(q >= amount, "quota exceeded");
            mintQuota[msg.sender] = q - amount;
        }
        _mint(to, amount);
    }

    /// @notice One-time airdrop that can run only once in contract lifetime.
    function oneTimeAirdrop(address[] calldata recipients, uint256[] calldata amounts) external onlyOwner {
        require(!oneTimeAirdropDone, "airdrop done");
        require(recipients.length == amounts.length, "length mismatch");
        require(recipients.length > 0, "empty");

        oneTimeAirdropDone = true;

        uint256 total;
        for (uint256 i = 0; i < recipients.length; i++) {
            _mint(recipients[i], amounts[i]);
            total += amounts[i];
        }

        emit OneTimeAirdropExecuted(recipients.length, total);
    }

    /// @notice Starts ownership transfer, completed by new owner via acceptOwnership.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "new owner zero");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        address old = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, owner);
    }

    /// @notice Token transfer.
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Approves spender for delegated transfers.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Transfers within approved allowance.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    /// @dev Core transfer logic.
    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "to zero");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "balance");
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
