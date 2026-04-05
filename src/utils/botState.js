/**
 * Shared in-memory bot state.
 * Using a mutable object so both index.js and adminHandler.js
 * reference the same object and see each other's mutations.
 * Resets to awake on every restart (intentional).
 */
const botState = {
  asleep: false,
};

module.exports = botState;
