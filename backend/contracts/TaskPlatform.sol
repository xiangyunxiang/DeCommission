// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract TaskPlatform {
    enum Status { Open, Claimed, Completed, Cancelled }

    struct Task {
        uint id;
        address payable employer; 
        address payable worker;
        string description;
        uint reward;
        Status status;
    }

    uint public taskCount = 0;
    mapping(uint => Task) public tasks;

    function createTask(string memory _description) public payable {
        require(msg.value > 0, "Reward must be greater than 0");
        taskCount++;
        tasks[taskCount] = Task(taskCount, payable(msg.sender), payable(address(0)), _description, msg.value, Status.Open);
    }

    function claimTask(uint _id) public {
        Task storage task = tasks[_id];
        require(task.status == Status.Open, "Task not available");
        require(msg.sender != task.employer, "Employer cannot claim own task");
        
        task.worker = payable(msg.sender);
        task.status = Status.Claimed;
    }

    function completeTask(uint _id) public {
        Task storage task = tasks[_id];
        require(msg.sender == task.employer, "Only employer can confirm");
        require(task.status == Status.Claimed, "Task must be claimed first");

        task.status = Status.Completed;
        task.worker.transfer(task.reward);
    }
}