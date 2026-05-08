const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer, writer, buyer] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("PrintToken");
  const token = await Token.deploy();
  await token.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("ElevatorOptionFactory");
  const factory = await Factory.deploy(await token.getAddress());
  await factory.waitForDeployment();

  // Seed common demo accounts so UI actions work immediately.
  const toPU = (n) => hre.ethers.parseUnits(n.toString(), 18);
  await (await token.mint(writer.address, toPU(5000))).wait();
  await (await token.mint(buyer.address, toPU(5000))).wait();

  const deployment = {
    network: "localhost",
    chainId: 31337,
    deployer: deployer.address,
    demoWriter: writer.address,
    demoBuyer: buyer.address,
    printToken: await token.getAddress(),
    elevatorOptionFactory: await factory.getAddress(),
    deployedAt: new Date().toISOString()
  };

  const outputPath = path.resolve(__dirname, "..", "web", "deployments.localhost.json");
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

  console.log("Local deployment complete:");
  console.log(JSON.stringify(deployment, null, 2));
  console.log(`Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
