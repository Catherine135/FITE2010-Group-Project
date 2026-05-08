require("@nomicfoundation/hardhat-ethers");
require("hardhat-contract-sizer");
require("@nomicfoundation/hardhat-chai-matchers");

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  contractSizer: {
    runOnCompile: true
  }
};