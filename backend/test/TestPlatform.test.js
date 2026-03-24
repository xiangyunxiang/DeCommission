const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TaskPlatform", function () {
  let TaskPlatform;
  let platform;
  let owner;      // The employer
  let addr1;      // The worker
  let addr2;      // Another user

  // This block runs before each test
  beforeEach(async function () {
    // Get signers (mock accounts) from Hardhat
    [owner, addr1, addr2] = await ethers.getSigners();

    // Deploy the contract
    TaskPlatform = await ethers.getContractFactory("TaskPlatform");
    platform = await TaskPlatform.deploy();
  });

  describe("Task Creation", function () {
    it("Should create a task with the correct reward", async function () {
      const reward = ethers.parseEther("1.0"); // 1 ETH
      
      // Create a task
      await platform.connect(owner).createTask("Fix my bug", { value: reward });

      const task = await platform.tasks(1);
      expect(task.description).to.equal("Fix my bug");
      expect(task.reward).to.equal(reward);
      expect(task.employer).to.equal(owner.address);
      expect(task.status).to.equal(0); // 0 corresponds to Status.Open
    });

    it("Should fail if no reward is sent", async function () {
      await expect(
        platform.connect(owner).createTask("Free work")
      ).to.be.revertedWith("Reward must be greater than 0");
    });
  });

  describe("Task Claiming", function () {
    beforeEach(async function () {
      await platform.connect(owner).createTask("Write a script", { 
        value: ethers.parseEther("2.0") 
      });
    });

    it("Should allow a worker to claim an open task", async function () {
      await platform.connect(addr1).claimTask(1);
      
      const task = await platform.tasks(1);
      expect(task.worker).to.equal(addr1.address);
      expect(task.status).to.equal(1); // 1 corresponds to Status.Claimed
    });

    it("Should not allow the employer to claim their own task", async function () {
      await expect(
        platform.connect(owner).claimTask(1)
      ).to.be.revertedWith("Employer cannot claim own task");
    });
  });

  describe("Task Completion and Payment", function () {
    const reward = ethers.parseEther("1.0");

    beforeEach(async function () {
      await platform.connect(owner).createTask("UI Design", { value: reward });
      await platform.connect(addr1).claimTask(1);
    });

    it("Should transfer reward to the worker when completed", async function () {
      // Get initial balance of the worker
      const initialBalance = await ethers.provider.getBalance(addr1.address);

      // Employer confirms completion
      await platform.connect(owner).completeTask(1);

      // Get final balance
      const finalBalance = await ethers.provider.getBalance(addr1.address);

      // Check if the worker received the reward
      expect(finalBalance).to.equal(initialBalance + reward);

      const task = await platform.tasks(1);
      expect(task.status).to.equal(2); // 2 corresponds to Status.Completed
    });

    it("Should not allow non-employers to complete the task", async function () {
      await expect(
        platform.connect(addr2).completeTask(1)
      ).to.be.revertedWith("Only employer can confirm");
    });
  });
});