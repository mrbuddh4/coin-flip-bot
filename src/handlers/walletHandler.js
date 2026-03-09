const { Markup } = require('telegraf');
const logger = require('../logger');

class WalletHandler {
  static async handleWalletCommand(ctx) {
    const userId = ctx.from.id;
    const models = ctx.state.models;

    try {
      // Get or create user profile
      let profile = await models.UserProfile.findByPk(userId);
      if (!profile) {
        profile = await models.UserProfile.create({ userId });
      }

      const evmAddress = profile.evmWalletAddress || '(not set)';
      const solAddress = profile.solanaWalletAddress || '(not set)';

      await ctx.reply(
        `<b>💳 Your Wallet Addresses</b>\n\n` +
        `<b>EVM Network:</b>\n<code>${evmAddress}</code>\n\n` +
        `<b>Solana Network:</b>\n<code>${solAddress}</code>\n\n` +
        `Choose what you'd like to do:`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Update EVM Address', 'update_evm_wallet')],
            [Markup.button.callback('✏️ Update Solana Address', 'update_solana_wallet')],
            [Markup.button.callback('❌ Remove All', 'remove_all_wallets')],
          ]).reply_markup,
        }
      );
    } catch (error) {
      logger.error('Error in handleWalletCommand:', error);
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
        `<b>Enter your EVM wallet address:</b>\n\n` +
        `Send me your EVM wallet address (e.g., 0x1234...)`,
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

      if (session.currentStep === 'AWAITING_EVM_ADDRESS') {
        // Basic validation for EVM address
        if (!/^0x[a-fA-F0-9]{40}$/.test(message)) {
          await ctx.reply(
            `❌ Invalid EVM address format.\n\n` +
            `Please provide a valid EVM wallet address (starting with 0x and 40 hex characters)`,
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
          `✅ EVM wallet address updated!\n\n` +
          `<code>${message}</code>`,
          { parse_mode: 'HTML' }
        );

        return true;
      } else if (session.currentStep === 'AWAITING_SOLANA_ADDRESS') {
        // Basic validation for Solana address
        if (!/^[1-9A-HJ-NP-Z]{32,44}$/.test(message)) {
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

        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error in processWalletAddressInput:', error);
      await ctx.reply('❌ Error processing wallet address. Please try again.');
      return true;
    }
  }
}

module.exports = WalletHandler;
