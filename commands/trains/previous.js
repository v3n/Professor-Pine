"use strict";

const log = require('loglevel').getLogger('PreviousCommand'),
  {MessageEmbed} = require('discord.js'),
  Commando = require('discord.js-commando'),
  {CommandGroup, PartyStatus, PartyType} = require('../../app/constants'),
  Helper = require('../../app/helper'),
  Notify = require('../../app/notify'),
  Gym = require('../../app/gym'),
  settings = require('../../data/settings'),
  PartyManager = require('../../app/party-manager');

class PreviousCommand extends Commando.Command {
  constructor(client) {
    super(client, {
      name: 'previous',
      group: CommandGroup.TRAIN,
      memberName: 'previous',
      aliases: ['previous-gym', 'prev', 'prev-gym'],
      description: 'Move the train to the previous gym in the route.',
      details: 'Use this command to move the raid train to the previous gym in the planned route.',
      examples: ['\t!next'],
      guildOnly: true
    });

    client.dispatcher.addInhibitor(message => {
      if (!!message.command && message.command.name === 'previous' &&
        !PartyManager.validParty(message.channel.id, PartyType.RAID_TRAIN)) {
        return ['invalid-channel', message.reply('You can only move a raid train through the route within a train channel!')];
      }
      return false;
    });
  }

  async run(message) {
    const party = PartyManager.getParty(message.channel.id);

    if (party.conductor && party.conductor.username !== message.author.username) {
      message.react(Helper.getEmoji(settings.emoji.thumbsDown) || '👎')
        .catch(err => log.error(err));

      message.channel.send(`${message.author}, you must be this train's conductor to move the gym along.`)
        .catch(err => log.error(err));
    } else {
      let info = await party.moveToPreviousGym(message.author),
        attendees = Object.entries(party.attendees)
          .filter(([attendee, attendeeStatus]) => attendee !== message.member.id &&
            attendeeStatus.status !== PartyStatus.COMPLETE)
          .map(([attendee, attendeeStatus]) => attendee);

      if (info && info.error) {
        message.reply(info.error)
          .then(errorMessage => {
            setTimeout(() => {
              errorMessage.delete();
            }, 30000);
          })
          .catch(err => log.error(err));
        return;
      }

      if (attendees.length > 0 && party.currentGym <= party.route.length) {
        const members = (await Promise.all(attendees
            .map(async attendeeId => await party.getMember(attendeeId))))
            .filter(member => member.ok === true)
            .map(member => member.member),
          gym = await Gym.getGym(party.route[party.currentGym]),
          gymName = !!gym.nickname ?
            gym.nickname :
            gym.name,
          text = 'This train is moving back to ' + gymName + '.';

        Notify.shout(message, members, text, 'trainMovement', message.member);
      }

      message.react(Helper.getEmoji(settings.emoji.thumbsUp) || '👍')
        .catch(err => log.error(err));

      party.refreshStatusMessages()
        .catch(err => log.error(err));
    }
  }
}

module.exports = PreviousCommand;
