const hre = require("hardhat");

async function main() {
  const platform = await hre.ethers.deployContract("TaskPlatform");
  await platform.waitForDeployment();

  console.log(`TaskPlatform deployed to: ${await platform.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});