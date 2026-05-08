// Hardhat-style test script skeleton: covers both CALL and PUT scenarios
// Before running, ensure hardhat + ethers are installed and compiler 0.8.20 is configured in hardhat.config.js
// TODO markers indicate fill-in sections for demo flow completion

const { expect } = require("chai");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = hre;
require("@nomicfoundation/hardhat-chai-matchers");

/**
 * Convert a human-readable PU amount into the token's base units (18 decimals).
 * @param {number|string} n - Amount in PU (human form)
 * @returns {bigint} Amount in base units (18 decimals)
 */
const toPU = (n) => ethers.parseUnits(n.toString(), 18);

/**
 * Ensure that the contract is deployed and log the address
 * @param {Contract} contract - Deployed contract instance
 * @param {string} name - Contract name for log output
 * @returns {Promise<string>} Contract address
 */
async function ensureDeployment(contract, name) {
  const address = await contract.getAddress();
  console.log (`    ${name} deployed to: ${address}`);
  return address;
}

/**
 * Creates an option and completes full setup (deposit + buyOption)
 * @param {Contract} factory - Factory contract instance
 * @param {Contract} token - PrintToken contract instance  
 * @param {Signer} writer - Option writer/seller
 * @param {Signer} buyer - Option buyer
 * @param {number} strikeTime - Strike threshold in minutes
 * @param {bigint} premium - Premium amount in PU
 * @param {bigint} collateral - Collateral amount in PU
 * @param {number} duration - Duration in seconds
 * @param {number} optionType - 0 = CALL, 1 = PUT
 * @param {bigint} [createFee=0] - Creation fee in ETH
 * @returns {Promise<{option: Contract, optionAddress: string}>}
 */
async function createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, optionType, createFee = 0) {
  const tx = await factory.connect(writer).createOption(
    strikeTime, premium, collateral, duration, optionType, { value: createFee }
  );
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => log.fragment && log.fragment.name === "OptionCreated");
  const optionAddress = event.args.option;
  const option = await ethers.getContractAt("ElevatorOption", optionAddress);

  // Writer deposit
  await token.connect(writer).approve(optionAddress, collateral);
  await option.connect(writer).deposit();
  const contractBalance = await option.contractBalance();
  expect(contractBalance).to.equal(collateral);

  // Buyer buyOption
  await token.connect(buyer).approve(optionAddress, premium);
  await option.connect(buyer).buyOption();

  const isActive = await option.isActive();
  const buyerAddress = await option.buyer();
  expect(isActive).to.be.true;
  expect(buyerAddress).to.equal(buyer.address);

  const writerBalance = await token.balanceOf(writer.address);

  return { option, optionAddress };
}

/**
 * Creates option without deposit/buy
 * @param {Contract} factory - Factory contract instance
 * @param {Signer} writer - Option writer
 * @param {number} strikeTime - Strike threshold in minutes
 * @param {bigint} premium - Premium amount in PU
 * @param {bigint} collateral - Collateral amount in PU
 * @param {number} duration - Duration in seconds
 * @param {number} optionType - 0 = CALL, 1 = PUT
 * @param {bigint} [createFee=0] - Creation fee in ETH
 * @returns {Promise<{option: Contract, optionAddress: string}>}
 */
async function createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, optionType, createFee = 0) {
  const tx = await factory.connect(writer).createOption(
    strikeTime, premium, collateral, duration, optionType, { value: createFee }
  );
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => log.fragment?.name === "OptionCreated");
  const optionAddress = event.args.option;
  const option = await ethers.getContractAt("ElevatorOption", optionAddress);
  return { option, optionAddress };
}


describe("Elevator Waiting-Time Option", function () {
  let deployer, writer, buyer, oracle;
  let token, factory;

  beforeEach(async () => {
    // Get test accounts
    [deployer, writer, buyer] = await ethers.getSigners();
    oracle = deployer;

    // Deploy PrintToken
    const Token = await ethers.getContractFactory("PrintToken");
    token = await Token.deploy();

    // Ensure contract is successfully deployed on-chain
    await ensureDeployment(token, "PrintToken");

    // Deploy Factory
    const Factory = await ethers.getContractFactory("ElevatorOptionFactory");
    factory = await Factory.deploy(token.getAddress());
    // Ensure contract is successfully deployed on-chain
    await ensureDeployment(factory, "ElevatorOptionFactory");

    // Prepare PU: owner mints and distributes tokens
    await token.mint(writer.address, toPU(1000));
    await token.mint(buyer.address, toPU(500));
  });

  const strikeTime = 10; // Strike threshold: 10 minutes
  const premium = toPU(100); // Premium: 100 PU
  const collateral = toPU(1000); // Collateral: 1000 PU
  const duration = 5 * 24 * 60 * 60; // Test duration: 5 days

  it("Scenario 1: CALL (Wait time > Strike time)", async () => {

    const { option } = await createAndSetupOption(
      factory, token, writer, buyer,
      strikeTime, premium, collateral, duration, 0 // CALL=0, PUT=1
    );

    // Fast-forward to expiry (using hardhat time.increase)
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    const timeToSkip = Number(expiry) - Number(currentTime);
    await time.increase(timeToSkip);

    // Oracle records actual waiting time (greater than strike)
    const actualTime = 15; // Set actualTime > strikeTime so CALL option can be exercised
    await option.connect(oracle).recordActualTime(actualTime);
        
    const recordedTime = await option.actualWaitTime();
    expect(Number(recordedTime)).to.equal(actualTime);

    // Buyer exercises and receives collateral
    const buyerBalanceBefore = await token.balanceOf(buyer.address);
    
    await option.connect(buyer).exercise();
    const buyerBalanceAfter = await token.balanceOf(buyer.address);

    // Verify balance changes and status flags
    expect(buyerBalanceAfter-buyerBalanceBefore).to.equal(collateral);
    const isExercised = await option.isExercised();
    expect(isExercised).to.be.true;

    // Contract balance should be 0
    const finalBalance = await option.contractBalance();
    expect(Number(finalBalance)).to.equal(0);
  });

  it("Scenario 2: PUT (Wait time < Strike time)", async () => {

    const { option } = await createAndSetupOption(
      factory, token, writer, buyer,
      strikeTime, premium, collateral, duration, 1 // CALL=0, PUT=1
    );


    // Fast-forward to expiry (using hardhat time.increase)
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    const timeToSkip = Number(expiry) - Number(currentTime);
    await time.increase(timeToSkip);

    // Oracle records actual waiting time (less than strike)

    const actualTime = 5; // Set actualTime < strikeTime so PUT option can be exercised
    await option.connect(oracle).recordActualTime(actualTime);
    const recordedTime = await option.actualWaitTime();
    expect(Number(recordedTime)).to.equal(actualTime);

    // Buyer exercises and receives collateral
    const buyerBalanceBefore = await token.balanceOf(buyer.address);
    
    await option.connect(buyer).exercise();
    const buyerBalanceAfter = await token.balanceOf(buyer.address);

    // Verify balance changes and status flags
    expect(buyerBalanceAfter-buyerBalanceBefore).to.equal(collateral);
    const isExercised = await option.isExercised();
    expect(isExercised).to.be.true;

    // Contract balance should be 0
    const finalBalance = await option.contractBalance();
    expect(Number(finalBalance)).to.equal(0);
    
  });
  
  it("Scenario 3: CALL fail (Wait time < Strike time)", async () => {
    
    const { option } = await createAndSetupOption(
      factory, token, writer, buyer,
      strikeTime, premium, collateral, duration, 0 // CALL=0, PUT=1
    );

    // Fast-forward to expiry (using hardhat time.increase)
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    const timeToSkip = Number(expiry) - Number(currentTime);
    await time.increase(timeToSkip);

    // Oracle records actual waiting time (less than strike)
    const actualTime = 5; // Set actualTime < strikeTime so CALL cannot be exercised and writer retrieves collateral
    await option.connect(oracle).recordActualTime(actualTime);
        
    const recordedTime = await option.actualWaitTime();
    expect(Number(recordedTime)).to.equal(actualTime);

    // Buyer tries to exercise and fails
    await expect(option.connect(buyer).exercise()).to.be.revertedWith("CALL: actual <= strike, cannot exercise");

    // Writer retrieves collateral
    const writerBalanceBefore = await token.balanceOf(writer.address);
    await option.connect(writer).retrieveExpired();
    const writerBalanceAfter = await token.balanceOf(writer.address);
      
    // Check balance changes and status flags
    expect(writerBalanceAfter - writerBalanceBefore).to.equal(collateral);
    expect(Number(await option.contractBalance())).to.equal(0);
    expect(await option.isCanceled()).to.be.true;
    expect(await option.isExercised()).to.be.false;

  });

  it("Scenario 4: PUT (Wait time > Strike time)", async () => {

    const { option } = await createAndSetupOption(
      factory, token, writer, buyer,
      strikeTime, premium, collateral, duration, 1 // CALL=0, PUT=1
    );

    // Fast-forward to expiry (using hardhat time.increase)
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    const timeToSkip = Number(expiry) - Number(currentTime);
    await time.increase(timeToSkip);

    // Oracle records actual waiting time (greater than strike)
    const actualTime = 15; // Set actualTime > strikeTime so PUT cannot be exercised and writer retrieves collateral
    await option.connect(oracle).recordActualTime(actualTime);
        
    const recordedTime = await option.actualWaitTime();
    expect(Number(recordedTime)).to.equal(actualTime);

    // Buyer tries to exercise and fails
    await expect(option.connect(buyer).exercise()).to.be.revertedWith("PUT: actual >= strike, cannot exercise");

    // Writer retrieves collateral
    const writerBalanceBefore = await token.balanceOf(writer.address);
    await option.connect(writer).retrieveExpired();
    const writerBalanceAfter = await token.balanceOf(writer.address);
      
    // Check balance changes and status flags
    expect(writerBalanceAfter - writerBalanceBefore).to.equal(collateral);
    expect(Number(await option.contractBalance())).to.equal(0);
    expect(await option.isCanceled()).to.be.true;
    expect(await option.isExercised()).to.be.false;

  });
});

describe("ElevatorOption failure scenarios", function () {
  let deployer, writer, buyer, oracle;
  let token, factory;

  beforeEach(async () => {
    // Get test accounts
    [deployer, writer, buyer] = await ethers.getSigners();
    oracle = deployer;

    // Deploy PrintToken
    const Token = await ethers.getContractFactory("PrintToken");
    token = await Token.deploy();

    // Deploy Factory
    const Factory = await ethers.getContractFactory("ElevatorOptionFactory");
    factory = await Factory.deploy(token.getAddress());

    // Prepare PU: owner mints and distributes tokens
    await token.mint(writer.address, toPU(1000));
    await token.mint(buyer.address, toPU(500));
  });

  const strikeTime = 10;
  const premium = toPU(100);
  const collateral = toPU(1000);
  const duration = 5 * 24 * 60 * 60; // 5 days

  it("Fail 1.1: writer deposits twice → revert", async () => {
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    await expect(option.connect(writer).deposit()).to.be.revertedWith("already deposited");
  });

  it ("Fail 1.2: writer deposited after expiry", async () =>{
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    
    // Jump to expiry first
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));

    // Writer tries to deposit collateral -> should fail
    await token.connect(writer).approve(optionAddress, collateral);
    await expect(option.connect(writer).deposit()).to.be.revertedWith("expired");
  });

  it ("Fail 1.3: non-writer cannot deposit", async () =>{
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(buyer).approve(optionAddress, collateral);
    await expect(option.connect(buyer).deposit()).to.be.revertedWith("only writer");
  });

  it("Fail 1.4: cannot deposit after cancel", async () => {
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    await option.connect(writer).cancelIfUnbought();
    // Deposit again
    await expect(option.connect(writer).deposit()).to.be.revertedWith("option canceled");
  });


  it ("Fail 2.1: buyer pays premium to an option not deposited", async () =>{
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    // deposit() is not called
    await token.connect(buyer).approve(optionAddress, premium);
    await expect(option.connect(buyer).buyOption()).to.be.revertedWith("not deposited yet");
  });

  it ("Fail 2.2: cannot deposit on cancelled option", async () =>{
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    await option.connect(writer).cancelIfUnbought();
    expect(await option.isCanceled()).to.be.true;
    
    await token.connect(writer).approve(optionAddress, collateral);
    await expect(option.connect(writer).deposit()).to.be.revertedWith("option canceled");
  });

  it("Fail 2.3: buyer buys twice -> revert", async () => {
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    await token.connect(buyer).approve(optionAddress, premium);
    await option.connect(buyer).buyOption();
    await expect(option.connect(buyer).buyOption()).to.be.revertedWith("already active");
  });

  it ("Fail 2.4: buyer buys after expiry", async () =>{
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await token.connect(buyer).approve(optionAddress, premium);
    await expect(option.connect(buyer).buyOption()).to.be.revertedWith("expired");
  });

  it("Fail 2.5: writer cannot buy own option → revert", async () => {
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    await token.connect(writer).approve(optionAddress, premium);
    await expect(option.connect(writer).buyOption()).to.be.revertedWith("writer cannot buy own option");
  });

  it ("Fail 3.1: change oracle after waiting time is recorded", async () => {
    const { option, optionAddress } = await createAndSetupOption(
    factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0
    );
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await option.connect(oracle).recordActualTime(15);
    await expect(option.connect(oracle).changeOracle(buyer.address)).to.be.revertedWith("time already recorded");
  });

  it ("Fail 3.2: change oracle address to zero address", async () => {
    const { option } = await createAndSetupOption(
    factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    await expect(option.connect(oracle).changeOracle(ethers.ZeroAddress)).to.be.revertedWith("oracle zero addr");
  });

  it ("Fail 3.3: change oracle address to writer", async () => {
    const { option } = await createAndSetupOption(
    factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    await expect(option.connect(oracle).changeOracle(writer.address)).to.be.revertedWith("oracle cannot be writer");
  });

  it ("Fail 3.4: change oracle address to buyer", async () => {
    const { option } = await createAndSetupOption(
    factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    await expect(option.connect(oracle).changeOracle(buyer.address)).to.be.revertedWith("oracle cannot be buyer");
  });

  it ("Fail 3.5: non-oracle tries to change oracle", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    await expect(option.connect(writer).changeOracle(oracle.address)).to.be.revertedWith("only oracle");
    await expect(option.connect(buyer).changeOracle(oracle.address)).to.be.revertedWith("only oracle");
  });

  it("Fail 4.1: non-oracle cannot record time → revert", async () => {
    const { option, optionAddress } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await expect(option.connect(buyer).recordActualTime(15)).to.be.revertedWith("only oracle");
  });

  it ("Fail 4.2: oracle record time to non-activated option", async () => {
    const { option, optionAddress } = await createOptionOnly(
    factory, writer, strikeTime, premium, collateral, duration, 0
    );
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await expect(option.connect(oracle).recordActualTime(15)).to.be.revertedWith("not active");
  });

  it ("Fail 4.3: record waiting time before expiry", async () =>{
    const { option, optionAddress } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    await expect(option.connect(oracle).recordActualTime(15)).to.be.revertedWith("not yet expired");
  });

  it ("Fail 4.4: record time twice", async () =>{
    const { option, optionAddress } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await option.connect(oracle).recordActualTime(15);
    await expect(option.connect(oracle).recordActualTime(10)).to.be.revertedWith("already recorded");
  });

  it ("Fail 4.5: waiting time exceeds range", async () =>{
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    const maxStrikeTime = await option.MAX_STRIKE_TIME();
    await expect(option.connect(oracle).recordActualTime(Number(maxStrikeTime) + 1)).to.be.revertedWith("actualTime out of range");
  });

  it ("Fail 5.1: non-buyer exercise option", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await option.connect(oracle).recordActualTime(15);
    await expect(option.connect(deployer).exercise()).to.be.revertedWith("only buyer");
  });

  it ("Fail 5.2: buyer try to exercise on cancelled options", async () => {
    const { option } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(option.getAddress(), collateral);
    await option.connect(writer).deposit();
    await option.connect(writer).cancelIfUnbought();
    await expect(option.connect(buyer).exercise()).to.be.revertedWith("option canceled");
  });

  it ("Fail 5.3: buyer exercise on non-activated options", async () => {
    // No need
    // This case is impossible, since buyer attains address at the same time with activating options (in buyOption()).
    // Fail 15 passed automatically
  }); 

  it("Fail 5.4: exercise twice -> revert", async () => {
    
    const { option, optionAddress } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime)); 
    await option.connect(oracle).recordActualTime(15);
    await option.connect(buyer).exercise();
    await expect(option.connect(buyer).exercise()).to.be.revertedWith("already exercised");
  });

  it("Fail 5.5: exercise without oracle recording -> revert", async () => {
    const { option, optionAddress } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await expect(option.connect(buyer).exercise()).to.be.revertedWith("time not recorded");
  });

  it("Fail 6.1: writer try to retrieve collateral when option not expired", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    await expect(option.connect(writer).retrieveExpired()).to.be.revertedWith("not expired yet");
  });

  it ("Fail 6.2: writer try to retrieve collateral after option exercised", async() =>{
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await option.connect(oracle).recordActualTime(15);
    await option.connect(buyer).exercise();
    await expect(option.connect(writer).retrieveExpired()).to.be.revertedWith("already exercised");
  });

  it ("Fail 6.3: non-writer try to retrieve collateral", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));
    await option.connect(oracle).recordActualTime(15);
    await option.connect(buyer).exercise();
    await expect(option.connect(buyer).retrieveExpired()).to.be.revertedWith("only writer");
  });

  it ("Fail 6.4: writer try to retrieve cancelled option collateral", async () => {
    const { option, optionAddress } = await createOptionOnly(
      factory, writer, strikeTime, premium, collateral, duration, 0
    );
    
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    
    await option.connect(writer).cancelIfUnbought();
    expect(await option.isCanceled()).to.be.true;
    
    await expect(option.connect(writer).retrieveExpired())
      .to.be.revertedWith("option canceled");
  });

  it("Fail 6.5: writer retrieve before oracle records time", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    const currentTime = await time.latest();
    await time.increase(Number(expiry) - Number(currentTime));

    await expect(option.connect(writer).retrieveExpired()).to.be.revertedWith("time not recorded");
  });

});

describe("ElevatorOption cancel scenarios", function(){
  let deployer, writer, buyer, oracle;
  let token, factory;

  beforeEach(async () => {
    // Get test accounts
    [deployer, writer, buyer] = await ethers.getSigners();
    oracle = deployer;

    // Deploy PrintToken
    const Token = await ethers.getContractFactory("PrintToken");
    token = await Token.deploy();

    // Deploy Factory
    const Factory = await ethers.getContractFactory("ElevatorOptionFactory");
    factory = await Factory.deploy(token.getAddress());

    // Prepare PU: owner mints and distributes tokens
    await token.mint(writer.address, toPU(1000));
    await token.mint(buyer.address, toPU(500));
  });

  const strikeTime = 10;
  const premium = toPU(100);
  const collateral = toPU(1000);
  const duration = 5 * 24 * 60 * 60; // 5 days
  
  describe ("cancelIfUnbought cases", () => {
    it("Success: writer cancels unbought option", async () => {
      
      const { option, optionAddress } = await createOptionOnly(
        factory, writer, strikeTime, premium, collateral, duration, 0
      );
      
      await token.connect(writer).approve(optionAddress, collateral);
      await option.connect(writer).deposit();
      
      const writerBalanceBefore = await token.balanceOf(writer.address);
      await option.connect(writer).cancelIfUnbought();
      const writerBalanceAfter = await token.balanceOf(writer.address);
      expect(writerBalanceAfter - writerBalanceBefore).to.equal(collateral);
      expect(await option.isCanceled()).to.be.true;
    });

    it("Fail 1: cancelIfUnbought after option bought", async () => {   
      const { option } = await createAndSetupOption(
        factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0
      );
      
      await expect(option.connect(writer).cancelIfUnbought()).to.be.revertedWith("already bought, cannot cancel");
    });

    it("Fail 2: cancelIfUnbought without deposit", async () => {
      const { option } = await createOptionOnly(
        factory, writer, strikeTime, premium, collateral, duration, 0
      );
      await expect(option.connect(writer).cancelIfUnbought()).to.be.revertedWith("nothing to cancel");
    });

    it ("Fail 3: cancelIfUnbought by non-writer", async () =>{
      const { option } = await createOptionOnly(
        factory, writer, strikeTime, premium, collateral, duration, 0
      );
      await expect(option.connect(buyer).cancelIfUnbought()).to.be.revertedWith("only writer");
    });

    it ("Fail 4: cancelIfUnbought after expiry", async () => {
      const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
      await token.connect(writer).approve(optionAddress, collateral);
      await option.connect(writer).deposit();

      const expiry = await option.expiry();
      const currentTime = await time.latest();
      await time.increase(Number(expiry) - Number(currentTime));

      await expect(option.connect(writer).cancelIfUnbought()).to.be.revertedWith("expired");
    });
  });

  describe("cancelIfInactive", () => {
    it("Success: cancelIfInactive after timeout", async () => {
      const { option, optionAddress } = await createOptionOnly(
        factory, writer, strikeTime, premium, collateral, duration, 0
      );

      await token.connect(writer).approve(optionAddress, collateral);
      await option.connect(writer).deposit();

      const inactiveTimeout = await option.INACTIVE_TIMEOUT();
      await time.increase(Number(inactiveTimeout) + 1);

      const writerBalanceBefore = await token.balanceOf(writer.address);
      await option.connect(buyer).cancelIfInactive();  // Callable by anyone
      const writerBalanceAfter = await token.balanceOf(writer.address);

      expect(writerBalanceAfter - writerBalanceBefore).to.equal(collateral);
      expect(await option.isCanceled()).to.be.true;
    });

    it("Fail 1: cancelIfInactive without deposit", async () => {
      
      const { option } = await createOptionOnly(
        factory, writer, strikeTime, premium, collateral, duration, 0
      );
      await expect(option.connect(writer).cancelIfInactive()).to.be.revertedWith("nothing to cancel");
    });

    it("Fail 2: cancelIfInactive before timeout", async () => {
      
      const { option, optionAddress } = await createOptionOnly(
        factory, writer, strikeTime, premium, collateral, duration, 0
      );

      await token.connect(writer).approve(optionAddress, collateral);
      await option.connect(writer).deposit();

      await expect(option.connect(buyer).cancelIfInactive()).to.be.revertedWith("timeout not reached");

    });

    it("Fail 3: cancelIfInactive after option bought", async () => {
      
      const { option } = await createAndSetupOption(
        factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0
      );

      const inactiveTimeout = await option.INACTIVE_TIMEOUT();
      await time.increase(Number(inactiveTimeout) + 1);

      await expect(option.connect(buyer).cancelIfInactive()).to.be.revertedWith("already active");
    });

  });

}) ;

describe("ElevatorOption event tests", function () {
  let deployer, writer, buyer, oracle;
  let token, factory;

  beforeEach(async () => {
    // Get test accounts
    [deployer, writer, buyer] = await ethers.getSigners();
    oracle = deployer;

    // Deploy PrintToken
    const Token = await ethers.getContractFactory("PrintToken");
    token = await Token.deploy();

    // Deploy Factory
    const Factory = await ethers.getContractFactory("ElevatorOptionFactory");
    factory = await Factory.deploy(token.getAddress());

    // Prepare PU: owner mints and distributes tokens
    await token.mint(writer.address, toPU(1000));
    await token.mint(buyer.address, toPU(500));
  });

  const strikeTime = 10; // Strike threshold: 10 minutes
  const premium = toPU(100); // Premium: 100 PU
  const collateral = toPU(1000); // Collateral: 1000 PU
  const duration = 5 * 24 * 60 * 60; // Test duration: 5 days

  it("Should emit Deposited event", async () => {
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    
    await expect(option.connect(writer).deposit()).to.emit(option, "Deposited").withArgs(writer.address, collateral);
  });

  it("Should emit OptionBought event", async () => {
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    await token.connect(buyer).approve(optionAddress, premium);
    
    await expect(option.connect(buyer).buyOption()).to.emit(option, "OptionBought").withArgs(buyer.address, premium);
  });

  it("Should emit CanceledUnbought event", async () => {
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    
    await expect(option.connect(writer).cancelIfUnbought()).to.emit(option, "CanceledUnbought").withArgs(writer.address, collateral);
  });

  it("Should emit CanceledInactive event", async () => { //Consider the case when buyer calls
    const { option, optionAddress } = await createOptionOnly(factory, writer, strikeTime, premium, collateral, duration, 0);
    await token.connect(writer).approve(optionAddress, collateral);
    await option.connect(writer).deposit();
    
    const inactiveTimeout = await option.INACTIVE_TIMEOUT();
    await time.increase(Number(inactiveTimeout) + 1);
    
    await expect(option.connect(buyer).cancelIfInactive()).to.emit(option, "CanceledInactive").withArgs(buyer.address, collateral);
  });

  it("Should emit OracleChanged event", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const newOracle = deployer.address; // Change oracle to deployer address for testing
    
    await expect(option.connect(oracle).changeOracle(newOracle)).to.emit(option, "OracleChanged").withArgs(oracle.address, newOracle);
  });

  it("Should emit ActualTimeRecorded event", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    await time.increase(Number(expiry) - Number(await time.latest()));
    
    await expect(option.connect(oracle).recordActualTime(15)).to.emit(option, "ActualTimeRecorded").withArgs(15);
  });

  it("Should emit Exercised event", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    await time.increase(Number(expiry) - Number(await time.latest()));
    await option.connect(oracle).recordActualTime(15);
    
    await expect(option.connect(buyer).exercise()).to.emit(option, "Exercised").withArgs(buyer.address, collateral);
  });

  it("Should emit Expired event", async () => {
    const { option } = await createAndSetupOption(factory, token, writer, buyer, strikeTime, premium, collateral, duration, 0);
    const expiry = await option.expiry();
    await time.increase(Number(expiry) - Number(await time.latest()));
    await option.connect(oracle).recordActualTime(5);  // CALL failure condition
    
    await expect(option.connect(writer).retrieveExpired()).to.emit(option, "Expired").withArgs(writer.address, collateral);
  });

});

describe("ElevatorOptionFactory test cases", function() {
  let deployer, writer, buyer;
  let token, factory;

  beforeEach(async () => {
    // Get test accounts
    [deployer, writer, buyer] = await ethers.getSigners();
        
    // Deploy PrintToken
    const Token = await ethers.getContractFactory("PrintToken");
    token = await Token.deploy();
        
    // Deploy Factory
    const Factory = await ethers.getContractFactory("ElevatorOptionFactory");
    factory = await Factory.deploy(token.getAddress());
        
    // Prepare PU: owner mints tokens to writer
    await token.mint(writer.address, toPU(10000));
  });
    
  describe("Deployment", function() {
    it("Success deployment", async () => {
      const tokenAddress = await token.getAddress();
      expect(await factory.token()).to.equal(tokenAddress);
      expect(await factory.admin()).to.equal(deployer.address);
    });
        
    it("Fail: token address cannot be zero", async function() {
      const Factory = await ethers.getContractFactory("ElevatorOptionFactory");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("token zero");
    });
  });
    
  describe("Admin permission tests", function() {
    describe("1: set rules", function() {
      const defaultRules = {
        createFee: 0,
        minInterval: 0,
        minDur: 60,
        maxDur: 30 * 24 * 60 * 60,
        minPrem: toPU(1),
        maxPrem: toPU(10000),
        minColl: toPU(1),
        maxColl: toPU(100000),
        minStrike: 1,
        maxStrike: 240
      };

      it("1.1: only admin can set rules", async () => {
        await expect(
          factory.connect(deployer).setRules(
            defaultRules.createFee,
            defaultRules.minInterval,
            defaultRules.minDur,
            defaultRules.maxDur,
            defaultRules.minPrem,
            defaultRules.maxPrem,
            defaultRules.minColl,
            defaultRules.maxColl,
            defaultRules.minStrike,
            defaultRules.maxStrike
          )
        ).to.not.be.reverted;
                    
        await expect(
          factory.connect(writer).setRules(
            defaultRules.createFee,
            defaultRules.minInterval,
            defaultRules.minDur,
            defaultRules.maxDur,
            defaultRules.minPrem,
            defaultRules.maxPrem,
            defaultRules.minColl,
            defaultRules.maxColl,
            defaultRules.minStrike,
            defaultRules.maxStrike
          )
        ).to.be.revertedWith("only admin");
      });

      it("1.2: should revert when minDuration > maxDuration", async () => {
        await expect(
          factory.connect(deployer).setRules(
            defaultRules.createFee,
            defaultRules.minInterval,
            100,   // minDuration
            50,    // maxDuration (min > max)
            defaultRules.minPrem,
            defaultRules.maxPrem,
            defaultRules.minColl,
            defaultRules.maxColl,
            defaultRules.minStrike,
            defaultRules.maxStrike
          )
        ).to.be.revertedWith("duration range");
      });

      it("1.3: should revert when minPremium > maxPremium", async () => {
        await expect(
          factory.connect(deployer).setRules(
            defaultRules.createFee,
            defaultRules.minInterval,
            defaultRules.minDur,
            defaultRules.maxDur,
            toPU(100),   // minPremium
            toPU(50),    // maxPremium (min > max)
            defaultRules.minColl,
            defaultRules.maxColl,
            defaultRules.minStrike,
            defaultRules.maxStrike
          )
        ).to.be.revertedWith("premium range");
      });

      it("1.4: should revert when minCollateral > maxCollateral", async () => {
        await expect(
          factory.connect(deployer).setRules(
            defaultRules.createFee,
            defaultRules.minInterval,
            defaultRules.minDur,
            defaultRules.maxDur,
            defaultRules.minPrem,
            defaultRules.maxPrem,
            toPU(100),   // minCollateral
            toPU(50),    // maxCollateral (min > max)
            defaultRules.minStrike,
            defaultRules.maxStrike
          )
        ).to.be.revertedWith("collateral range");
      });

      it("1.5: should revert when minStrikeTime > maxStrikeTime", async () => {
        await expect(
          factory.connect(deployer).setRules(
            defaultRules.createFee,
            defaultRules.minInterval,
            defaultRules.minDur,
            defaultRules.maxDur,
            defaultRules.minPrem,
            defaultRules.maxPrem,
            defaultRules.minColl,
            defaultRules.maxColl,
            10,   // minStrikeTime
            5     // maxStrikeTime (min > max)
          )
        ).to.be.revertedWith("strike range");
      });
    });
    
    describe("2: withdraw fees", function() {
      let fee;
    
      beforeEach(async () => {
        // Set rules with non-zero fee
        fee = ethers.parseEther("0.01");
        await factory.connect(deployer).setRules(
          fee, 0, 60, 30*24*60*60, toPU(1), toPU(10000), toPU(1), toPU(100000), 1, 240
        );
        // Give writer ETH
        await deployer.sendTransaction({
          to: writer.address, value: ethers.parseEther("1.0")
        });
        // Create an option and generate fees
        await factory.connect(writer).createOption(
          10, toPU(100), toPU(1000), 86400, 0, { value: fee }
        );
      });

      it("2.1: only admin can withdraw fees", async () => {
        await expect(
            factory.connect(deployer).withdrawFees(deployer.address, fee)
        ).to.not.be.reverted;
        
        // Writer is not admin, cannot withdraw fees
        await expect(
            factory.connect(writer).withdrawFees(writer.address, fee)
        ).to.be.revertedWith("only admin");
        
        // Buyer is not admin, cannot withdraw fees
        await expect(
            factory.connect(buyer).withdrawFees(buyer.address, fee)
        ).to.be.revertedWith("only admin");
      });

      it("2.2: cannot send fees to zero address", async () => {
        await expect(
          factory.connect(deployer).withdrawFees(ethers.ZeroAddress, fee)
        ).to.be.revertedWith("to zero");
      });

      it("2.3: withdraw amount shouldn't exceed accumulated amount", async () => {
        const accrued = await factory.accruedFees();
        expect(accrued).to.equal(fee);
        
        // Cannot withdraw excessive amount
        await expect(
            factory.connect(deployer).withdrawFees(deployer.address, fee + ethers.parseEther("0.01"))
        ).to.be.revertedWith("exceed accrued");

        // Can withdraw fees with the accrued amount
        await expect(
            factory.connect(deployer).withdrawFees(deployer.address, fee)
        ).to.not.be.reverted;

        // Accrued amount should be 0 after withdrawal
        expect(await factory.accruedFees()).to.equal(0);

        // Another withdrawal should fail since there are no more accrued fees
        await expect(
            factory.connect(deployer).withdrawFees(deployer.address, fee)
        ).to.be.revertedWith("exceed accrued");
      });
    });

    describe("3: transfer admin", function() {
      let newAdmin;
      beforeEach(async () => {
        // Get test account for new admin
        const signers = await ethers.getSigners();
        newAdmin = signers[3];
      });

      it("3.1: only admin can transfer the admin identity", async () => {
        // Admin can trnasder admin identity to newAdmin
        await expect(
          factory.connect(deployer).transferAdmin(newAdmin.address)
        ).to.not.be.reverted;
        
        // Writer is not admin, cannot transfer admin
        await expect(
          factory.connect(writer).transferAdmin(newAdmin.address)
        ).to.be.revertedWith("only admin");
        
        // Buyer is not admin, cannot transfer admin
        await expect(
          factory.connect(buyer).transferAdmin(newAdmin.address)
        ).to.be.revertedWith("only admin");
      });

      it("3.2: cannot transfer to zero address", async () => {
        await expect(
            factory.connect(deployer).transferAdmin(ethers.ZeroAddress)
        ).to.be.revertedWith("new admin zero");
      });

      it("3.4: only pending admin can accept", async () => {
        await factory.connect(deployer).transferAdmin(newAdmin.address);
        
        await expect(
          factory.connect(writer).acceptAdmin()
        ).to.be.revertedWith("not pending admin"); // Writer is not pending admin, cannot accept
        
        await expect(
          factory.connect(newAdmin).acceptAdmin()
        ).to.not.be.reverted;
      });
    });

    describe("4: relay the recording of actual waiting time", function() {
      
      let optionAddress;
      let option;

      beforeEach(async () => {
        // Prepare PU: owner mints and distributes tokens
        await token.mint(writer.address, toPU(1000));
        await token.mint(buyer.address, toPU(500));

        // Create and set up an option
        const result = await createAndSetupOption(
          factory, token, writer, buyer,
          10, toPU(100), toPU(1000), 86400, 0, 0
        );
        option = result.option;
        optionAddress = result.optionAddress;

        // Fast forward time to after option expiry
        const expiry = await option.expiry();
        await time.increase(Number(expiry) - Number(await time.latest()));
      });

      it("4.1: only admin can relay", async () => {
        const actualTime = 15;
            
        // Admin (deployer) relay records of the actual waiting time
        await expect(
          factory.connect(deployer).relayRecordActualTime(optionAddress, actualTime)
        ).to.emit(factory, "ActualTimeRelayed").withArgs(optionAddress, actualTime);
            
        // Verify that the actual waiting time has been recorded
        expect(await option.actualTimeRecorded()).to.be.true;
        expect(await option.actualWaitTime()).to.equal(actualTime);
      });

      it("4.2: non-admin cannot relay", async () => {
        const actualTime = 15;
        //Writer cannot relay
        await expect(
          factory.connect(writer).relayRecordActualTime(optionAddress, actualTime)
        ).to.be.revertedWith("only admin");

        //Buyer cannot relay
        await expect(
          factory.connect(buyer).relayRecordActualTime(optionAddress, actualTime)
        ).to.be.revertedWith("only admin");
            
        //Verify that the actual waiting time has not been recorded
        expect(await option.actualTimeRecorded()).to.be.false;
      });
    });

    describe("5: relay oracle change", function() {
      
      let optionAddress;
      let option;
      let newOracle;

      beforeEach(async () => {
        // Owner mints tokens to writer and buyer
        await token.mint(writer.address, toPU(1000));
        await token.mint(buyer.address, toPU(500));

        // Create and set up an option
        const result = await createAndSetupOption(
          factory, token, writer, buyer,
          10, toPU(100), toPU(1000), 86400, 0, 0
        );
        option = result.option;
        optionAddress = result.optionAddress;

        // Get test account for new oracle
        const signers = await ethers.getSigners();
        newOracle = signers[4].address;
      });

      it("5.1: only admin can relay", async () => {
        const originalOracle = await option.oracle();

        // Admin (deployer) relay the oracle change
        await expect(
          factory.connect(deployer).relayChangeOracle(optionAddress, newOracle)
        ).to.emit(option, "OracleChanged").withArgs(originalOracle, newOracle);
        
        // Verify that the oracle has been changed
        expect(await option.oracle()).to.equal(newOracle);
      });

      it("5.2: non-admin cannot relay", async () => {
        const originalOracle = await option.oracle();
        
        //Writer cannot relay
        await expect(
          factory.connect(writer).relayChangeOracle(optionAddress, newOracle)
        ).to.be.revertedWith("only admin");

        //Buyer cannot relay
        await expect(
          factory.connect(buyer).relayChangeOracle(optionAddress, newOracle)
        ).to.be.revertedWith("only admin");
        
        //Verify that the oracle has not been changed
        expect(await option.oracle()).to.equal(originalOracle);
      });
    });
  });
    
  describe("Create options - successful creation", function() {
    const strikeTime = 10;
    const premium = toPU(100);
    const collateral = toPU(1000);
    const duration = 7 * 24 * 60 * 60;  // 7 days
    const optionType = 0;  // CALL
    const createFee = 0;

    it("Successfully create an option and emit the event", async function() {
      const tx = await factory.connect(writer).createOption(
          strikeTime, premium, collateral, duration, optionType,
          { value: createFee }
      );

      const receipt = await tx.wait();

      const event = receipt.logs.find(
          log => log.fragment && log.fragment.name === "OptionCreated"
      );
      
      expect(event).to.exist;
      expect(event.args.writer).to.equal(writer.address);
      expect(event.args.optionType).to.equal(optionType);
      expect(event.args.strikeTime).to.equal(strikeTime);
      expect(event.args.premium).to.equal(premium);
      expect(event.args.collateral).to.equal(collateral);
    });
  
    it("Created options should be stored in allOptions array", async function() {
      const tx = await factory.connect(writer).createOption(
        strikeTime, premium, collateral, duration, optionType,
        { value: createFee }
      );
        
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => log.fragment && log.fragment.name === "OptionCreated"
      );
      const optionAddress = event.args.option;
        
      const allOptions = await factory.getAllOptions();
      expect(allOptions).to.include(optionAddress);
      expect(await factory.allOptionsLength()).to.equal(1);
    });
    
    it("Created options should be stored in writer's option array", async function() {
      await factory.connect(writer).createOption(
        strikeTime, premium, collateral, duration, optionType,
        { value: createFee }
      );
        
      const writerOptions = await factory.getWriterOptionsBatch(writer.address, 0, 10);
      expect(writerOptions.length).to.equal(1);
      expect(await factory.writerOptionsLength(writer.address)).to.equal(1);
    });
    
    it("Multiple options should be stored correctly", async function() {
      // Create the first option
      await factory.connect(writer).createOption(
        strikeTime, premium, collateral, duration, optionType,
        { value: createFee }
      );
      
      // Create the second option with different parameters
      await factory.connect(writer).createOption(
        strikeTime + 5, premium, collateral, duration, optionType,
        { value: createFee }
      );
      
      // Verify the length of allOptions array
      expect(await factory.allOptionsLength()).to.equal(2);
      
      // Verify the length of writer's option array
      expect(await factory.writerOptionsLength(writer.address)).to.equal(2);
      
      // Verify pagination
      const page1 = await factory.getAllOptionsBatch(0, 1);
      expect(page1.length).to.equal(1);
      
      const page2 = await factory.getAllOptionsBatch(1, 1);
      expect(page2.length).to.equal(1);
    });
    
    it("Different writers' options should be stored separately", async function() {
      // Get a different writer
      const [deployer, writer1, writer2, buyer] = await ethers.getSigners();
      await token.mint(writer2.address, toPU(10000));
      
      // writer1 creates an option
      await factory.connect(writer1).createOption(
          strikeTime, premium, collateral, duration, optionType,
          { value: createFee }
      );
      
      // writer2 creates an option
      await factory.connect(writer2).createOption(
          strikeTime, premium, collateral, duration, optionType,
          { value: createFee }
      );
      
      // Verify each writer's option list
      expect(await factory.writerOptionsLength(writer1.address)).to.equal(1);
      expect(await factory.writerOptionsLength(writer2.address)).to.equal(1);
      
      // Verify the allOptions list
      expect(await factory.allOptionsLength()).to.equal(2);
    });
    
    it("Should create different option types (CALL and PUT)", async function() {
      // Create a CALL option (type = 0)
      const callTx = await factory.connect(writer).createOption(
        strikeTime, premium, collateral, duration, 0,
        { value: createFee }
      );
      const callReceipt = await callTx.wait();
      const callEvent = callReceipt.logs.find(
        log => log.fragment && log.fragment.name === "OptionCreated"
      );
      
      // Create a PUT option (type = 1)
      const putTx = await factory.connect(writer).createOption(
        strikeTime, premium, collateral, duration, 1,
        { value: createFee }
      );
      const putReceipt = await putTx.wait();
      const putEvent = putReceipt.logs.find(
        log => log.fragment && log.fragment.name === "OptionCreated"
      );
      
      // Verify types
      expect(callEvent.args.optionType).to.equal(0);
      expect(putEvent.args.optionType).to.equal(1);
      
      // Verify the two options are stored successfully
      expect(await factory.allOptionsLength()).to.equal(2);
    });
    
    it("Should get writer options with pagination", async function() {
      // Create 5 options
      for (let i = 0; i < 5; i++) {
          await factory.connect(writer).createOption(
              strikeTime + i, premium, collateral, duration, optionType,
              { value: createFee }
          );
      }
      
      // Verify pagination
      const page1 = await factory.getWriterOptionsBatch(writer.address, 0, 2);
      expect(page1.length).to.equal(2);
      
      const page2 = await factory.getWriterOptionsBatch(writer.address, 2, 2);
      expect(page2.length).to.equal(2);
      
      const page3 = await factory.getWriterOptionsBatch(writer.address, 4, 2);
      expect(page3.length).to.equal(1);
      
      // Verify empty page for out-of-bounds query
      const emptyPage = await factory.getWriterOptionsBatch(writer.address, 10, 5);
      expect(emptyPage.length).to.equal(0);
    });
    
    it("Should return empty array for writer with no options", async function() {
      const [deployer, writer1, writer2] = await ethers.getSigners();
      // writer1 creates an option
      await factory.connect(writer1).createOption(
          strikeTime, premium, collateral, duration, optionType,
          { value: createFee }
      );
      // writer2 creates no option and check writer2's option records
      const writer2Options = await factory.getWriterOptionsBatch(writer2.address, 0, 10);
      expect(writer2Options.length).to.equal(0);
      expect(await factory.writerOptionsLength(writer2.address)).to.equal(0);
    });
  });
  
  describe("Create options - parameter validation", function() {
    const validStrikeTime = 10;
    const validPremium = toPU(100);
    const validCollateral = toPU(1000);
    const validDuration = 86400;  // 1 day
    const validType = 0;
    const validFee = 0;
    
    describe("strikeTime validation", function() {
      it("Pass: valid strikeTime (1-240)", async function() {
        // Minimum value
        await expect(
          factory.connect(writer).createOption(1, validPremium, validCollateral, validDuration, validType, { value: validFee })
        ).to.not.be.reverted;
            
        // Maximum value
        await expect(
          factory.connect(writer).createOption(240, validPremium, validCollateral, validDuration, validType, { value: validFee })
        ).to.not.be.reverted;
            
        // Middle value
        await expect(
          factory.connect(writer).createOption(120, validPremium, validCollateral, validDuration, validType, { value: validFee })
        ).to.not.be.reverted;
      });
        
      it("Fail 1: strikeTime too small (< 1)", async function() {
        await expect(
        factory.connect(writer).createOption(0, validPremium, validCollateral, validDuration, validType, { value: validFee })
        ).to.be.revertedWith("bad strike");
      });
        
      it("Fail 2: strikeTime too big (> 240)", async function() {
        await expect(
        factory.connect(writer).createOption(241, validPremium, validCollateral, validDuration, validType, { value: validFee })
        ).to.be.revertedWith("bad strike");
            
        await expect(
        factory.connect(writer).createOption(1000, validPremium, validCollateral, validDuration, validType, { value: validFee })
        ).to.be.revertedWith("bad strike");
      });
    });
    
    describe("premium validation", function() {
      it("Pass: valid premium (1-1000 PU)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, toPU(500), validCollateral, validDuration, validType, { value: validFee })
        ).to.not.be.reverted;
      });
        
      it("Fail 1: premium too small (< 1 PU)", async function() {
          await expect(
              factory.connect(writer).createOption(validStrikeTime, 0, validCollateral, validDuration, validType, { value: validFee })
          ).to.be.revertedWith("bad premium");
      });
      
      it("Fail 2: premium too big (> 1000 PU)", async function() {
          await expect(
              factory.connect(writer).createOption(validStrikeTime, toPU(1500), toPU(2000), validDuration, validType, { value: validFee })
          ).to.be.revertedWith("bad premium");
      });
    });
    
    describe("collateral validation", function() {
      it("Pass: valid collateral (1-10000 PU)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, toPU(5000), validDuration, validType, { value: validFee })
        ).to.not.be.reverted;
      });
        
      it("Fail 1: collateral too small (< 1 PU)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, toPU(1), toPU(0), validDuration, validType, { value: validFee })
        ).to.be.revertedWith("bad collateral");
      });
        
      it("Fail 2: collateral too big (> 10000 PU)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, toPU(15000), validDuration, validType, { value: validFee })
        ).to.be.revertedWith("bad collateral");
      });
    });
    
    describe("premium < collateral requirement", function() {
      it("Pass: premium < collateral", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, toPU(100), toPU(200), validDuration, validType, { value: validFee })
          ).to.not.be.reverted;
        });
        
        it("Fail 1: premium = collateral", async function() {
            await expect(
                factory.connect(writer).createOption(validStrikeTime, toPU(1000), toPU(1000), validDuration, validType, { value: validFee })
            ).to.be.revertedWith("premium must be < collateral");
        });
        
        it("Fail 2: premium > collateral", async function() {
            await expect(
                factory.connect(writer).createOption(validStrikeTime, toPU(300), toPU(200), validDuration, validType, { value: validFee })
            ).to.be.revertedWith("premium must be < collateral");
        });
    });
    
    describe("duration validation", function() {
      it("Pass: valid duration (5 min - 30 days)", async function() {
        // Minimum value
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, 5 * 60, validType, { value: validFee })
        ).to.not.be.reverted;
            
        // Maximum value
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, 30 * 24 * 60 * 60, validType, { value: validFee })
        ).to.not.be.reverted;
            
        // Middle value: 7 days
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, 7 * 24 * 60 * 60, validType, { value: validFee })
        ).to.not.be.reverted;
      });
        
      it("Fail 1: duration too short (< 5 mins)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, 10, validType, { value: validFee })
        ).to.be.revertedWith("bad duration");
            
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, 299, validType, { value: validFee })
        ).to.be.revertedWith("bad duration");
      });
      
      it("Fail 2: duration too long (> 30days)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, 31 * 24 * 60 * 60, validType, { value: validFee })
        ).to.be.revertedWith("bad duration");
            
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, 365 * 24 * 60 * 60, validType, { value: validFee })
        ).to.be.revertedWith("bad duration");
      });
    });
    
    describe("option type validation", function() {
      it("Pass: valid type (0 or 1)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, 0, { value: validFee })
        ).to.not.be.reverted;
            
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, 1, { value: validFee })
        ).to.not.be.reverted;
      });
        
      it("Fail 1: invalid type (> 1)", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, 2, { value: validFee })
        ).to.be.revertedWith("invalid type");
            
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, 99, { value: validFee })
        ).to.be.revertedWith("invalid type");
      });
    });

    describe("create fee validation", function() {
      beforeEach(async () => {
        // Set a non-zero create fee
        const fee = ethers.parseEther("0.01");
        
        // Set rules
        await factory.connect(deployer).setRules(
          fee, 0, 60, 30*24*60*60,
          toPU(1), toPU(10000), toPU(1), toPU(100000), 1, 240
        );

        // Give writer ETH to pay fees
        await deployer.sendTransaction({
          to: writer.address, value: ethers.parseEther("1.0")
        });
      });
            
      it("Pass: pay correct fee", async function() {
        const fee = ethers.parseEther("0.01");
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: fee })
        ).to.not.be.reverted;
      });
            
      it("Fail 1: pay insufficient fee", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: 0 })
        ).to.be.revertedWith("wrong create fee");
      });
            
      it("Fail 2: pay excess fee", async function() {
        const doubleFee = ethers.parseEther("0.02");
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: doubleFee })
        ).to.be.revertedWith("wrong create fee");
      });
    })

    describe ("Rate limiting validation", function (){
      beforeEach(async () => {
        // Set rules
        await factory.connect(deployer).setRules(
          0, 10, 60, 30*24*60*60,toPU(1), toPU(10000), toPU(1), toPU(100000), 1, 240
        );
      });
            
      it("Pass 1: first creation", async function() {
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: 0 })
        ).to.not.be.reverted;
      });
            
      it("Fail: second creation too soon", async function() {
        await factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: 0 });
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: 0 })
        ).to.be.revertedWith("rate limited");
      });
            
      it("Pass 2: wait then create", async function() {
        await factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: 0 });
        await time.increase(11);
        await expect(
          factory.connect(writer).createOption(validStrikeTime, validPremium, validCollateral, validDuration, validType, { value: 0 })
        ).to.not.be.reverted;
      });
    });
  });

  describe("ElevatorOptionFactory event tests", function(){
    let deployer, writer, buyer;
    let token, factory;
    let newAdmin;
    let optionAddress;
    let option;

    beforeEach(async () => {
      // Get test accounts
      [deployer, writer, buyer] = await ethers.getSigners();
      const signers = await ethers.getSigners();
      newAdmin = signers[3];

      // Deploy PrintToken
      const Token = await ethers.getContractFactory("PrintToken");
      token = await Token.deploy();

      // Deploy Factory
      const Factory = await ethers.getContractFactory("ElevatorOptionFactory");
      factory = await Factory.deploy(token.getAddress());

      // Prepare PU: owner mints and distributes tokens
      await token.mint(writer.address, toPU(10000));
      await token.mint(buyer.address, toPU(5000));
    });

    describe("OptionCreated event", function() {
      it("Should emit OptionCreated with correct parameters when creating an option", async () => {
        const strikeTime = 10;
        const premium = toPU(100);
        const collateral = toPU(1000);
        const duration = 86400;
        const optionType = 0;
        const createFee = 0;

        await expect(factory.connect(writer).createOption(strikeTime, premium, collateral, duration, optionType, { value: createFee }))
        .to.emit(factory, "OptionCreated")
      });
    });

    describe("RulesUpdated event", function() {
      it("Should emit RulesUpdated when admin updates rules", async () => {
        const createFeeWei = ethers.parseEther("0.01");
        const minCreateInterval = 10;
        const minDuration = 300;
        const maxDuration = 30 * 24 * 60 * 60;
        const minPremium = toPU(1);
        const maxPremium = toPU(1000);
        const minCollateral = toPU(1);
        const maxCollateral = toPU(10000);
        const minStrikeTime = 1;
        const maxStrikeTime = 240;

        await expect(
          factory.connect(deployer).setRules(
            createFeeWei, minCreateInterval, minDuration, maxDuration,
            minPremium, maxPremium, minCollateral, maxCollateral,
            minStrikeTime, maxStrikeTime
          )
        ).to.emit(factory, "RulesUpdated")
          .withArgs(
            createFeeWei, minCreateInterval, minDuration, maxDuration,
            minPremium, maxPremium, minCollateral, maxCollateral,
            minStrikeTime, maxStrikeTime
          );
      });

      it("Should emit RulesUpdated when admin changes only some rules", async () => {
        const newMinDuration = 600;  // 10 minutes
        const newMaxDuration = 15 * 24 * 60 * 60;  // 15 days

        await expect(
          factory.connect(deployer).setRules(
            0, 0, newMinDuration, newMaxDuration,
            toPU(1), toPU(1000), toPU(1), toPU(10000), 1, 240
          )
        ).to.emit(factory, "RulesUpdated");
      });
    });
    
    describe("AdminTransferStarted event", function() {
      it("Should emit AdminTransferStarted when admin initiates transfer", async () => {
        await expect(
          factory.connect(deployer).transferAdmin(newAdmin.address)
        ).to.emit(factory, "AdminTransferStarted")
          .withArgs(deployer.address, newAdmin.address);
      });

    });

    describe("AdminTransferred event", function() {
      beforeEach(async () => {
        // Initiate admin transfer to newAdmin
        await factory.connect(deployer).transferAdmin(newAdmin.address);
      });

      it("Should emit AdminTransferred when new admin accepts", async () => {
        await expect(
          factory.connect(newAdmin).acceptAdmin()
        ).to.emit(factory, "AdminTransferred")
          .withArgs(deployer.address, newAdmin.address);
      });
    });

    describe("FeesWithdrawn event", function() {
      let fee;

      beforeEach(async () => {
        // Set rules with a non-zero create fee
        fee = ethers.parseEther("0.01");
        await factory.connect(deployer).setRules(
          fee, 0, 60, 30*24*60*60,
          toPU(1), toPU(10000), toPU(1), toPU(100000), 1, 240
        );

        // Give writer ETH to pay fees
        await deployer.sendTransaction({
          to: writer.address,
          value: ethers.parseEther("1.0")
        });

        // Create an option
        await factory.connect(writer).createOption(
          10, toPU(100), toPU(1000), 86400, 0,
          { value: fee }
        );
      });


      it("Should emit FeesWithdrawn when admin withdraws fees", async () => {
        await expect(
          factory.connect(deployer).withdrawFees(deployer.address, fee)
        ).to.emit(factory, "FeesWithdrawn")
          .withArgs(deployer.address, fee);
      });

      it("Should emit FeesWithdrawn when withdrawing to different address", async () => {
        const recipient = buyer.address;
        await expect(
          factory.connect(deployer).withdrawFees(recipient, fee)
        ).to.emit(factory, "FeesWithdrawn")
          .withArgs(recipient, fee);
      });

    });

    describe("ActualTimeRelayed event", function() {
      beforeEach(async () => {
        // Create and set up an option
        const result = await createAndSetupOption(
          factory, token, writer, buyer,
           10, toPU(100), toPU(1000), 86400, 0
        );
        option = result.option;
        optionAddress = result.optionAddress;

        // Fast forward time to after option expiry
        const expiry = await option.expiry();
        await time.increase(Number(expiry) - Number(await time.latest()));
      });

      it("Should emit ActualTimeRelayed when admin relays actual time", async () => {
        const actualTime = 15;
        await expect(
          factory.connect(deployer).relayRecordActualTime(optionAddress, actualTime)
        ).to.emit(factory, "ActualTimeRelayed")
          .withArgs(optionAddress, actualTime);
      });

      it("Should emit ActualTimeRelayed with different actual times", async () => {
        const actualTime = 8;
        await expect(
          factory.connect(deployer).relayRecordActualTime(optionAddress, actualTime)
        ).to.emit(factory, "ActualTimeRelayed")
          .withArgs(optionAddress, actualTime);
      });
    }); 
  });
});

describe("PrintToken test cases", function() {
  let deployer, user1, user2, minter;
  let token;
    
  const toPU = (n) => ethers.parseUnits(n.toString(), 18);
    
  beforeEach(async () => {
    // Get test accounts
    [deployer, user1, user2, minter] = await ethers.getSigners();

    // Deploy PrintToken
    const Token = await ethers.getContractFactory("PrintToken");
    token = await Token.deploy();
  });
    
  describe("constructor test ", function() {
    it("Should set name, symbol, decimals, owner correctly", async () => {
      expect(await token.name()).to.equal("Print Unit");
      expect(await token.symbol()).to.equal("PU");
      expect(await token.decimals()).to.equal(18);
      expect(await token.owner()).to.equal(deployer.address);
    });
  });
    
  describe("mint test", function() {
    it("Owner can mint coins", async () => {
      await token.connect(deployer).mint(user1.address, toPU(1000));
      expect(await token.balanceOf(user1.address)).to.equal(toPU(1000))
    });
        
    it("Non-owner cannot mint coins (if it is not set to be the minter)", async () => {
      await expect(
        token.connect(user1).mint(user2.address, toPU(100))
      ).to.be.revertedWith("not minter");
    });
        
    it("Cannot mint to zero address", async () => {
      await expect(
        token.connect(deployer).mint(ethers.ZeroAddress, toPU(100))
      ).to.be.revertedWith("mint to zero");
    });
  });
    
  describe("setMinter test", function() {
    it("Only owner can set minter", async () => {
      // Owner can set the minter
      await expect(
        token.connect(deployer).setMinter(minter.address, true, toPU(1000))
      ).to.not.be.reverted;
            
      // Non-owner cannot set the minter
      await expect(
        token.connect(user1).setMinter(minter.address, true, toPU(1000))
      ).to.be.revertedWith("only owner");
    });
        
    it("Minter cannot be zero address", async () => {
      await expect(
        token.connect(deployer).setMinter(ethers.ZeroAddress, true, toPU(1000))
      ).to.be.revertedWith("minter zero");
    });
        
    it("Verify isMinter and mintQuota are correct", async () => {
      await token.connect(deployer).setMinter(minter.address, true, toPU(1000));
            
      expect(await token.isMinter(minter.address)).to.be.true;
      expect(await token.mintQuota(minter.address)).to.equal(toPU(1000));
    });
  });
    
  describe("minter mint test", function() {
      beforeEach(async () => {
        // Set minter with a quota of 1000 PU
        await token.connect(deployer).setMinter(minter.address, true, toPU(1000));
      });
      
      it("Minter can mint coins within the quota", async () => {
        await token.connect(minter).mint(user1.address, toPU(500));
        expect(await token.balanceOf(user1.address)).to.equal(toPU(500));
      });
      
      it("Minter cannot mint beyond the quota", async () => {
        await expect(
          token.connect(minter).mint(user1.address, toPU(1500))
        ).to.be.revertedWith("quota exceeded");
      });
      
      it("Quota decreases after minting", async () => {
        await token.connect(minter).mint(user1.address, toPU(300));
        expect(await token.mintQuota(minter.address)).to.equal(toPU(700));
      });
      
      it("Unauthorized minter cannot mint", async () => {
        await token.connect(deployer).setMinter(minter.address, false, 0);
          
        await expect(
          token.connect(minter).mint(user1.address, toPU(100))
        ).to.be.revertedWith("not minter");
      });
  });

  describe("oneTimeAirdrop test", function() {
    it("Only the owner can do airdrop", async () => {
      const recipients = [user1.address];
      const amounts = [toPU(100)];
          
      await expect(
        token.connect(deployer).oneTimeAirdrop(recipients, amounts)
      ).to.not.be.reverted;
          
      await expect(
        token.connect(user1).oneTimeAirdrop(recipients, amounts)
      ).to.be.revertedWith("only owner");
    });
      
    it("Airdrop can only be executed once", async () => {
      const recipients = [user1.address];
      const amounts = [toPU(100)];
          
      await token.connect(deployer).oneTimeAirdrop(recipients, amounts);
          
      await expect(
        token.connect(deployer).oneTimeAirdrop(recipients, amounts)
      ).to.be.revertedWith("airdrop done");
    });
      
    it("Recipients and amounts must have the same length", async () => {
      const recipients = [user1.address, user2.address];
      const amounts = [toPU(100)]; //length mismatch
          
      await expect(
        token.connect(deployer).oneTimeAirdrop(recipients, amounts)
      ).to.be.revertedWith("length mismatch");
    });
      
    it("Verify that the balance is correct after airdrop", async () => {
      const recipients = [user1.address, user2.address];
      const amounts = [toPU(100), toPU(200)];
          
      await token.connect(deployer).oneTimeAirdrop(recipients, amounts);
          
      expect(await token.balanceOf(user1.address)).to.equal(toPU(100));
      expect(await token.balanceOf(user2.address)).to.equal(toPU(200));
      expect(await token.totalSupply()).to.equal(toPU(300));
    });
  });
    
  describe("transfer test", function() {
    beforeEach(async () => {
      // Mint some tokens to user1 for testing transfers
      await token.connect(deployer).mint(user1.address, toPU(1000));
    });
      
    it("Transfer success", async () => {
      await token.connect(user1).transfer(user2.address, toPU(300));
          
      expect(await token.balanceOf(user1.address)).to.equal(toPU(700));
      expect(await token.balanceOf(user2.address)).to.equal(toPU(300));
    });
      
    it("Transfer fails when there is insufficient balance", async () => {
      await expect(
        token.connect(user1).transfer(user2.address, toPU(1500))
      ).to.be.revertedWith("balance");
    });
      
    it("Transfer fails when transferring to zero address", async () => {
      await expect(
        token.connect(user1).transfer(ethers.ZeroAddress, toPU(100))
      ).to.be.revertedWith("to zero");
    });
  });
    
  describe("approve test", function() {
    beforeEach(async () => {
      // Mint some tokens to user1 for testing approvals
      await token.connect(deployer).mint(user1.address, toPU(1000));
    });
      
    it("Approve success", async () => {
      await token.connect(user1).approve(user2.address, toPU(300));
          
      const allowance = await token.allowance(user1.address, user2.address);
      expect(allowance).to.equal(toPU(300));
    });
      
  });
    
  describe("transferFrom test", function() {
    beforeEach(async () => {
      // Mint some tokens to user1 and approve user2 for testing transferFrom
      await token.connect(deployer).mint(user1.address, toPU(1000));
      await token.connect(user1).approve(user2.address, toPU(500));
    });
      
    it("Transfer success", async () => {
      await token.connect(user2).transferFrom(user1.address, user2.address, toPU(300));
          
      expect(await token.balanceOf(user1.address)).to.equal(toPU(700));
      expect(await token.balanceOf(user2.address)).to.equal(toPU(300));
          
      const allowance = await token.allowance(user1.address, user2.address);
      expect(allowance).to.equal(toPU(200));
    });
      
    it("Transfer fail as allowance is reached", async () => {
      await expect(
      token.connect(user2).transferFrom(user1.address, user2.address, toPU(600))
      ).to.be.revertedWith("allowance");
    });
      
    it("Transfer fail due to insufficient balance", async () => {
      await token.connect(user1).approve(user2.address, toPU(2000));
      await expect(
        token.connect(user2).transferFrom(user1.address, user2.address, toPU(1500))
      ).to.be.revertedWith("balance");
    });
  });
    
  describe("ownership transfer test", function() {
    let newOwner;
    
    beforeEach(async () => {
      // Set a new owner
      newOwner = user1;
    });
    
    it("Only owner can initiate a transfer ownership execution", async () => {
      await expect(
        token.connect(deployer).transferOwnership(newOwner.address)
      ).to.not.be.reverted;
        
      await expect(
        token.connect(user1).transferOwnership(newOwner.address)
      ).to.be.revertedWith("only owner");
    });
    
    it("Cannot transfer to zero address", async () => {
      await expect(
        token.connect(deployer).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWith("new owner zero");
    });
    
    it("pendingOwner should equal to the address we are transferring to", async () => {
      await token.connect(deployer).transferOwnership(newOwner.address);
      expect(await token.pendingOwner()).to.equal(newOwner.address);
    });
    
    it("Only pendingOwner can accept the transfer", async () => {
      await token.connect(deployer).transferOwnership(newOwner.address);
        
      await expect(
        token.connect(user2).acceptOwnership()
      ).to.be.revertedWith("not pending owner");
        
      await expect(
        token.connect(newOwner).acceptOwnership()
      ).to.not.be.reverted;
    });
    
    it("Update owner and pendingOwner after a transder", async () => {
      await token.connect(deployer).transferOwnership(newOwner.address);
      await token.connect(newOwner).acceptOwnership();
        
      expect(await token.owner()).to.equal(newOwner.address);
      expect(await token.pendingOwner()).to.equal(ethers.ZeroAddress);
    });
    
  });

  describe("PrintToken event tests", function() {
    let deployer, user1, user2, minter;
    let token;

    beforeEach(async () => {
      // Get test accounts
      [deployer, user1, user2, minter] = await ethers.getSigners();

      // Deploy PrintToken
      const Token = await ethers.getContractFactory("PrintToken");
      token = await Token.deploy();
    });

    describe("Transfer event", function() {
      beforeEach(async () => {
        // Mint some tokens to user1 for testing transfers
        await token.connect(deployer).mint(user1.address, toPU(1000));
      });

      it("Should emit Transfer when minting", async () => {
        await expect(token.connect(deployer).mint(user2.address, toPU(500)))
          .to.emit(token, "Transfer")
          .withArgs(ethers.ZeroAddress, user2.address, toPU(500));
      });

      it("Should emit Transfer when transferring", async () => {
        await expect(token.connect(user1).transfer(user2.address, toPU(300)))
          .to.emit(token, "Transfer")
          .withArgs(user1.address, user2.address, toPU(300));
      });
    });

    describe("Approval event", function() {
      beforeEach(async () => {
        // Mint some tokens to user1 for testing approvals
        await token.connect(deployer).mint(user1.address, toPU(1000));
      });

      it("Should emit Approval when approving", async () => {
        await expect(token.connect(user1).approve(user2.address, toPU(300)))
          .to.emit(token, "Approval")
          .withArgs(user1.address, user2.address, toPU(300));
      });
    });


    describe("MinterUpdated event", function() {
      it("Should emit MinterUpdated when setting minter", async () => {
        await expect(token.connect(deployer).setMinter(minter.address, true, toPU(1000)))
          .to.emit(token, "MinterUpdated")
          .withArgs(minter.address, true, toPU(1000));
      });

      it("Should emit MinterUpdated when disabling minter", async () => {
        await token.connect(deployer).setMinter(minter.address, true, toPU(1000));
        await expect(token.connect(deployer).setMinter(minter.address, false, 0))
          .to.emit(token, "MinterUpdated")
          .withArgs(minter.address, false, 0);
      });

      it("Should emit MinterUpdated when updating quota", async () => {
        await token.connect(deployer).setMinter(minter.address, true, toPU(500));
        await expect(token.connect(deployer).setMinter(minter.address, true, toPU(1000)))
          .to.emit(token, "MinterUpdated")
          .withArgs(minter.address, true, toPU(1000));
      });
    });

    describe("OneTimeAirdropExecuted event", function() {
      it("Should emit OneTimeAirdropExecuted when airdrop is executed", async () => {
        const recipients = [user1.address, user2.address];
        const amounts = [toPU(100), toPU(200)];

        await expect(token.connect(deployer).oneTimeAirdrop(recipients, amounts))
          .to.emit(token, "OneTimeAirdropExecuted")
          .withArgs(2, toPU(300));
      });

      it("Should emit correct total amount for single recipient", async () => {
        const recipients = [user1.address];
        const amounts = [toPU(500)];

        await expect(token.connect(deployer).oneTimeAirdrop(recipients, amounts))
          .to.emit(token, "OneTimeAirdropExecuted")
          .withArgs(1, toPU(500));
      });
    });


    describe("OwnershipTransferStarted event", function() {
      let newOwner;

      beforeEach(async () => {
        // Set a new owner
        newOwner = user1;
      });

      it("Should emit OwnershipTransferStarted when transfer is initiated", async () => {
        await expect(token.connect(deployer).transferOwnership(newOwner.address))
          .to.emit(token, "OwnershipTransferStarted")
          .withArgs(deployer.address, newOwner.address);
      });

    });

    describe("OwnershipTransferred event", function() {
      let newOwner;

      beforeEach(async () => {
        // Set a new owner and initiate an ownership transfer
        newOwner = user1;
        await token.connect(deployer).transferOwnership(newOwner.address);
      });

      it("Should emit OwnershipTransferred when new owner accepts", async () => {
        await expect(token.connect(newOwner).acceptOwnership())
          .to.emit(token, "OwnershipTransferred")
          .withArgs(deployer.address, newOwner.address);
      });
    });
  });
});
