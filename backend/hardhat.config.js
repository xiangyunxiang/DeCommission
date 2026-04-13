require("@nomicfoundation/hardhat-toolbox");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",
  networks: {
    hardhat: { chainId: 31337 },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    }
  }
};

// ── 一键部署 + 同步 MetaMask 区块缓存 ────────────────────────────────────────
// 用法: npx hardhat deploy-and-sync --network localhost
// 效果:
//   1. 部署所有合约
//   2. 挖 100 个空块（让区块号超过 MetaMask 任何可能的缓存值）
//   3. 自动把 DataFetcher.json 复制到前端
task("deploy-and-sync", "Deploy contracts and sync MetaMask block cache")
  .setAction(async (_, hre) => {
    const { ethers, network } = hre;

    // ── Step 1: 部署合约 ──────────────────────────────────────────────────
    console.log("\n📦 Deploying contracts...\n");

    const [deployer] = await ethers.getSigners();
    console.log("Deploying with:", deployer.address);

    // ReviewerRegistry (先部署，ProductMarket 需要它)
    const Registry = await ethers.getContractFactory("ReviewerRegistry");
    const registry = await Registry.deploy(ethers.ZeroAddress);
    await registry.waitForDeployment();

    // ProductMarket
    const Market = await ethers.getContractFactory("ProductMarket");
    const market = await Market.deploy(await registry.getAddress());
    await market.waitForDeployment();

    // DisputeManager
    const Dispute = await ethers.getContractFactory("DisputeManager");
    const dispute = await Dispute.deploy(
      await registry.getAddress(),
      await market.getAddress()
    );
    await dispute.waitForDeployment();

    // DataFetcher
    const Fetcher = await ethers.getContractFactory("DataFetcher");
    const fetcher = await Fetcher.deploy(
      await market.getAddress(),
      await dispute.getAddress()
    );
    await fetcher.waitForDeployment();

    // TaskPlatform
    const Task = await ethers.getContractFactory("TaskPlatform");
    const task = await Task.deploy();
    await task.waitForDeployment();

    // 互相注册
    await market.setDisputeManager(await dispute.getAddress());
    await registry.setMarketContract(await market.getAddress());

    const addresses = {
      ProductMarket:     await market.getAddress(),
      ReviewerRegistry:  await registry.getAddress(),
      DisputeManager:    await dispute.getAddress(),
      DataFetcher:       await fetcher.getAddress(),
      TaskPlatform:      await task.getAddress(),
    };

    console.log("ProductMarket:   ", addresses.ProductMarket);
    console.log("ReviewerRegistry:", addresses.ReviewerRegistry);
    console.log("DisputeManager:  ", addresses.DisputeManager);
    console.log("DataFetcher:     ", addresses.DataFetcher);
    console.log("TaskPlatform:    ", addresses.TaskPlatform);

    // ── Step 2: 写入 deployedAddresses.json ──────────────────────────────
    const outPath = path.resolve(
      __dirname,
      "../frontend/src/contract/deployedAddresses.json"
    );
    fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
    console.log("\n✅ Addresses written to:", outPath);

    // ── Step 3: 复制 DataFetcher.json 到前端 ─────────────────────────────
    const artifactSrc = path.resolve(
      __dirname,
      "artifacts/contracts/DataFetcher.sol/DataFetcher.json"
    );
    const artifactDst = path.resolve(
      __dirname,
      "../frontend/src/contract/DataFetcher.json"
    );
    fs.copyFileSync(artifactSrc, artifactDst);
    console.log("✅ DataFetcher.json copied to frontend");

    // ── Step 4: 挖 100 个空块，解决 MetaMask 区块缓存不同步问题 ──────────
    console.log("\n⛏  Mining 100 empty blocks to sync MetaMask...");
    for (let i = 0; i < 100; i++) {
      await network.provider.send("evm_mine");
    }
    const blockNum = await ethers.provider.getBlockNumber();
    console.log(`✅ Done. Current block number: ${blockNum}`);
    console.log("\n🚀 Ready! Refresh your browser and reset MetaMask account once.\n");
  });