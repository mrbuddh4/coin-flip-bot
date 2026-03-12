const { Markup } = require('telegraf');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

class WalletHandler {
  static async handleWalletCommand(ctx) {
    const userId = ctx.from.id;
    const models = ctx.state.models;
    logger.info(`[WALLET] Command received from user ${userId}`);

    try {
      // Ensure deposit wallet columns exist (in case migration hasn't run)
      try {
        logger.info(`[WALLET] Running database migration for user ${userId}`);
        await models.sequelize.query(`
          ALTER TABLE "UserProfiles" 
          ADD COLUMN IF NOT EXISTS "evmDepositWalletAddress" VARCHAR(255)
        `);
        await models.sequelize.query(`
          ALTER TABLE "UserProfiles" 
          ADD COLUMN IF NOT EXISTS "solanaDepositWalletAddress" VARCHAR(255)
        `);
        logger.info(`[WALLET] Migration complete for user ${userId}`);
      } catch (migrationErr) {
        // Columns might already exist, continue
        logger.debug('Deposit wallet columns already exist or migration handled', migrationErr.message);
      }
      
      logger.info(`[WALLET] Fetching profile for user ${userId}`);
      
      // Get or create user profile
      let profile = await models.UserProfile.findByPk(userId);
      if (!profile) {
        profile = await models.UserProfile.create({ userId });
      }

      const evmAddress = profile.evmWalletAddress || '(not set)';
      const solAddress = profile.solanaWalletAddress || '(not set)';
      const evmDepositWallet = profile.evmDepositWalletAddress || '(not set)';
      const solDepositWallet = profile.solanaDepositWalletAddress || '(not set)';

      logger.info(`[WALLET] Sending reply to user ${userId}`, {
        evm: evmAddress,
        sol: solAddress,
        evmDeposit: evmDepositWallet,
        solDeposit: solDepositWallet,
      });

      await ctx.reply(
        `<b>💳 Your Wallet Addresses</b>\n\n` +
        `<b>Paxeer Network - Receive Winnings:</b>\n<code>${evmAddress}</code>\n\n` +
        `<b>Paxeer Network - Send Deposits:</b>\n<code>${evmDepositWallet}</code>\n\n` +
        `<b>Solana Network - Receive Winnings:</b>\n<code>${solAddress}</code>\n\n` +
        `<b>Solana Network - Send Deposits:</b>\n<code>${solDepositWallet}</code>\n\n` +
        `Choose what you'd like to do:`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Update Paxeer Receive Wallet', 'update_evm_wallet')],
            [Markup.button.callback('✏️ Update Paxeer Deposit Wallet', 'update_evm_deposit_wallet')],
            [Markup.button.callback('✏️ Update Solana Receive Wallet', 'update_solana_wallet')],
            [Markup.button.callback('✏️ Update Solana Deposit Wallet', 'update_solana_deposit_wallet')],
            [Markup.button.callback('❌ Remove All', 'remove_all_wallets')],
          ]).reply_markup,
        }
      );
    } catch (error) {
      logger.error(`[WALLET] Error in handleWalletCommand for user ${userId}:`, error);
      await ctx.reply('❌ Error loading wallet profile. Please try again.');
    }
  }

  static async handleUpdateEVM(ctx) {
    const userId = ctx.from.id;
    const models = ctx.state.models;

    try {
      // Create session to prompt for EVM address
      await models.BotSession.destroy({
        where: { userId, sessionType: 'UPDATING_WALLET' },
      });

      const session = await models.BotSession.create({
        userId,
        sessionType: 'UPDATING_WALLET',
        currentStep: 'AWAITING_EVM_ADDRESS',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minute expiry
      });

      await ctx.editMessageText(
        `<b>Enter your Paxeer wallet address:</b>\n\n` +
        `Send me your Paxeer wallet address (e.g., 0x1234...)`,

        {
          parse_mode: 'HTML',
        }
      );

      // Remove the keyboard
      await ctx.editMessageReplyMarkup(undefined);
    } catch (error) {
      logger.error('Error in handleUpdateEVM:', error);
      await ctx.answerCbQuery('Error updating wallet', true);
    }
  }

  static async handleUpdateSolana(ctx) {
    const userId = ctx.from.id;
    const models = ctx.state.models;

    try {
      // Create session to prompt for Solana address
      await models.BotSession.destroy({
        where: { userId, sessionType: 'UPDATING_WALLET' },
      });

      const session = await models.BotSession.create({
        userId,
        sessionType: 'UPDATING_WALLET',
        currentStep: 'AWAITING_SOLANA_ADDRESS',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minute expiry
      });

      await ctx.editMessageText(
        `<b>Enter your Solana wallet address:</b>\n\n` +
        `Send me your Solana wallet address (e.g., ABC123def...)`,
        {
          parse_mode: 'HTML',
        }
      );

      // Remove the keyboard
      await ctx.editMessageReplyMarkup(undefined);
    } catch (error) {
      logger.error('Error in handleUpdateSolana:', error);
      await ctx.answerCbQuery('Error updating wallet', true);
    }
  }

  static async handleUpdateEVMDeposit(ctx) {
    const userId = ctx.from.id;
    const models = ctx.state.models;

    try {
      // Create session to prompt for EVM deposit address
      await models.BotSession.destroy({
        where: { userId, sessionType: 'UPDATING_WALLET' },
      });

      const session = await models.BotSession.create({
        userId,
        sessionType: 'UPDATING_WALLET',
        currentStep: 'AWAITING_EVM_DEPOSIT_ADDRESS',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minute expiry
      });

      await ctx.editMessageText(
        `<b>Set your Paxeer deposit wallet:</b>\n\n` +
        `This is the wallet address you'll send deposits FROM.\n\n` +
        `Send me your Paxeer wallet address (e.g., 0x1234...)`,
        {
          parse_mode: 'HTML',
        }
      );

      // Remove the keyboard
      await ctx.editMessageReplyMarkup(undefined);
    } catch (error) {
      logger.error('Error in handleUpdateEVMDeposit:', error);
      await ctx.answerCbQuery('Error updating deposit wallet', true);
    }
  }

  static async handleUpdateSolanaDeposit(ctx) {
    const userId = ctx.from.id;
    const models = ctx.state.models;

    try {
      // Create session to prompt for Solana deposit address
      await models.BotSession.destroy({
        where: { userId, sessionType: 'UPDATING_WALLET' },
      });

      const session = await models.BotSession.create({
        userId,
        sessionType: 'UPDATING_WALLET',
        currentStep: 'AWAITING_SOLANA_DEPOSIT_ADDRESS',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minute expiry
      });

      await ctx.editMessageText(
        `<b>Set your Solana deposit wallet:</b>\n\n` +
        `This is the wallet address you'll send deposits FROM.\n\n` +
        `Send me your Solana wallet address (e.g., ABC123def...)`,
        {
          parse_mode: 'HTML',
        }
      );

      // Remove the keyboard
      await ctx.editMessageReplyMarkup(undefined);
    } catch (error) {
      logger.error('Error in handleUpdateSolanaDeposit:', error);
      await ctx.answerCbQuery('Error updating deposit wallet', true);
    }
  }

  static async handleRemoveAll(ctx) {
    const userId = ctx.from.id;
    const models = ctx.state.models;

    try {
      const profile = await models.UserProfile.findByPk(userId);
      if (profile) {
        profile.evmWalletAddress = null;
        profile.solanaWalletAddress = null;
        await profile.save();
      }

      await ctx.editMessageText(
        `✅ All wallet addresses removed.\n\n` +
        `You can set them again anytime using /wallet`,
        {
          parse_mode: 'HTML',
        }
      );

      await ctx.editMessageReplyMarkup(undefined);
    } catch (error) {
      logger.error('Error in handleRemoveAll:', error);
      await ctx.answerCbQuery('Error removing wallets', true);
    }
  }

  static async processWalletAddressInput(ctx, models) {
    const userId = ctx.from.id;
    const message = ctx.message.text;

    try {
      // Check for active wallet update session
      const session = await models.BotSession.findOne({
        where: { userId, sessionType: 'UPDATING_WALLET' },
      });

      if (!session) {
        return false;
      }

      // Get or create profile
      let profile = await models.UserProfile.findByPk(userId);
      if (!profile) {
        profile = await models.UserProfile.create({ userId });
      }

      const { getBlockchainManager } = require('../blockchain/manager');
      const { getDB } = require('../database');

      if (session.currentStep === 'AWAITING_EVM_ADDRESS') {
        // Basic validation for Paxeer address
        if (!/^0x[a-fA-F0-9]{40}$/.test(message)) {
          await ctx.reply(
            `❌ Invalid Paxeer address format.\n\n` +
            `Please provide a valid Paxeer wallet address (starting with 0x and 40 hex characters)`,
            { parse_mode: 'HTML' }
          );
          return true;
        }

        profile.evmWalletAddress = message;
        await profile.save();

        await models.BotSession.destroy({
          where: { id: session.id },
        });

        await ctx.reply(
          `✅ Paxeer wallet address updated!\n\n` +
          `<code>${message}</code>`,
          { parse_mode: 'HTML' }
        );

        // Find and continue any pending flip
        await this.continueFlipAfterWallet(ctx, userId, models, 'EVM');

        return true;
      } else if (session.currentStep === 'AWAITING_SOLANA_ADDRESS') {
        // Basic validation for Solana address (Base58: no I, O, l, o)
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(message)) {
          await ctx.reply(
            `❌ Invalid Solana address format.\n\n` +
            `Please provide a valid Solana wallet address (Base58 encoded, 32-44 characters)`,
            { parse_mode: 'HTML' }
          );
          return true;
        }

        profile.solanaWalletAddress = message;
        await profile.save();

        await models.BotSession.destroy({
          where: { id: session.id },
        });

        await ctx.reply(
          `✅ Solana wallet address updated!\n\n` +
          `<code>${message}</code>`,
          { parse_mode: 'HTML' }
        );

        // Find and continue any pending flip
        await this.continueFlipAfterWallet(ctx, userId, models, 'Solana');

        return true;
      } else if (session.currentStep === 'AWAITING_EVM_DEPOSIT_ADDRESS') {
        // Basic validation for Paxeer address
        if (!/^0x[a-fA-F0-9]{40}$/.test(message)) {
          await ctx.reply(
            `❌ Invalid Paxeer address format.\n\n` +
            `Please provide a valid Paxeer wallet address (starting with 0x and 40 hex characters)`,
            { parse_mode: 'HTML' }
          );
          return true;
        }

        profile.evmDepositWalletAddress = message;
        await profile.save();

        await models.BotSession.destroy({
          where: { id: session.id },
        });

        await ctx.reply(
          `✅ Paxeer deposit wallet set!\n\n` +
          `<code>${message}</code>\n\n` +
          `You'll send coin flip deposits FROM this wallet.`,
          { parse_mode: 'HTML' }
        );

        return true;
      } else if (session.currentStep === 'AWAITING_SOLANA_DEPOSIT_ADDRESS') {
        // Basic validation for Solana address (Base58: no I, O, l, o)
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(message)) {
          await ctx.reply(
            `❌ Invalid Solana address format.\n\n` +
            `Please provide a valid Solana wallet address (Base58 encoded, 32-44 characters)`,
            { parse_mode: 'HTML' }
          );
          return true;
        }

        profile.solanaDepositWalletAddress = message;
        await profile.save();

        await models.BotSession.destroy({
          where: { id: session.id },
        });

        await ctx.reply(
          `✅ Solana deposit wallet set!\n\n` +
          `<code>${message}</code>\n\n` +
          `You'll send coin flip deposits FROM this wallet.`,
          { parse_mode: 'HTML' }
        );

        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error in processWalletAddressInput:', error);
      await ctx.reply('❌ Error processing wallet address. Please try again.');
      return true;
    }
  }

  static async continueFlipAfterWallet(ctx, userId, models, network) {
    try {
      // Find an active flip session
      const flipSession = await models.BotSession.findOne({
        where: {
          userId,
          sessionType: { [Op.in]: ['INITIATING', 'CONFIRMING_DEPOSIT'] },
        },
      });

      if (!flipSession) {
        logger.info('No active flip to continue', { userId, network });
        return;
      }

      const flip = await models.CoinFlip.findByPk(flipSession.data?.flipId || flipSession.coinFlipId);
      if (!flip) {
        logger.warn('Flip not found for continuation', { flipSessionId: flipSession.id });
        return;
      }

      // Check if this is the right network
      if (flip.tokenNetwork !== network) {
        logger.info('Flip network mismatch, skipping auto-continue', { flipNetwork: flip.tokenNetwork, userNetwork: network });
        return;
      }

      logger.info('Continuing flip after wallet update', { flipId: flip.id, userId, network });

      // Update session to awaiting deposit
      flipSession.currentStep = 'AWAITING_DEPOSIT';
      await flipSession.save();

      // Show deposit instructions
      const blockchainManager = require('../blockchain/manager').getBlockchainManager();
      const botWalletAddress = blockchainManager.getBotWalletAddress(flip.tokenNetwork);
      const formattedWager = parseFloat(flip.wagerAmount).toLocaleString('en-US', { maximumFractionDigits: 6 });

      // Store wallet address in flip
      const userProfile = await models.UserProfile.findByPk(userId);
      if (flipSession.sessionType === 'INITIATING') {
        flip.creatorDepositWalletAddress = network === 'EVM' ? 
          userProfile?.evmWalletAddress :
          userProfile?.solanaWalletAddress;
      } else if (flipSession.sessionType === 'CONFIRMING_DEPOSIT') {
        flip.challengerDepositWalletAddress = network === 'EVM' ? 
          userProfile?.evmWalletAddress :
          userProfile?.solanaWalletAddress;
      }
      await flip.save();

      await ctx.reply(
        `💰 <b>Send Your Deposit</b>\n\n` +
        `You have <b>3 minutes</b> to complete this.\n\n` +
        `<b>Wager Amount:</b> ${formattedWager} ${flip.tokenSymbol}\n` +
        `<b>Network:</b> ${flip.tokenNetwork}\n\n` +
        `📮 <b>Send to this address:</b>\n\n` +
        `<code>${botWalletAddress}</code>\n\n` +
        `Once sent, click the button below:`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback(
              '✅ I Sent the Deposit',
              flipSession.sessionType === 'INITIATING' ? `creator_deposit_confirmed_${flip.id}` : `deposit_confirmed_${flip.id}`
            )],
          ]).reply_markup,
        }
      );
    } catch (error) {
      logger.error('Error continuing flip after wallet update:', error);
    }
  }
}

module.exports = WalletHandler;
