import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("Counter", function () {
  it("starts at zero", async function () {
    const counter = await ethers.deployContract("Counter");
    expect(await counter.count()).to.equal(0);
  });

  it("increments correctly", async function () {
    const counter = await ethers.deployContract("Counter");
    await counter.increment();
    expect(await counter.count()).to.equal(1);
  });

  it("reverts when decrementing below zero", async function () {
    const counter = await ethers.deployContract("Counter");
    await expect(counter.decrement()).to.be.revertedWith(
      "Counter: cannot go below zero"
    );
  });
});