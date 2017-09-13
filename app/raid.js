"use strict";

const moment = require('moment'),
	settings = require('../data/settings'),
	storage = require('node-persist'),
	Constants = require('./constants'),
	Discord = require('discord.js'),
	Gym = require('./gym'),
	NaturalArgumentType = require('../types/natural'),
	EndTimeType = require('../types/time');

class Raid {
	constructor() {
		this.active_raid_storage = storage.create({
			dir: 'raids/active',
			forgiveParseErrors: true
		});
		this.active_raid_storage.initSync();

		this.completed_raid_storage = storage.create({
			dir: 'raids/complete',
			forgiveParseErrors: true
		});
		this.completed_raid_storage.initSync();

		// maps channel ids to raid info for that channel
		this.raids = Object.create(null);

		this.active_raid_storage
			.forEach((channel_id, raid) => this.raids[channel_id] = raid);

		// cache of roles, populated on client login
		this.roles = Object.create(null);

		// cache of emoji ids, populated on client login
		this.emojis = Object.create(null);

		// loop to clean up raids periodically
		this.update = setInterval(() => {
			const now = moment().valueOf(),
				start_clear_time = now + (settings.start_clear_time) * 60 * 1000,
				deletion_time = now + (settings.deletion_warning_time * 60 * 1000);

			Object.entries(this.raids)
				.forEach(([channel_id, raid]) => {
					if (raid.hatch_time && now > raid.hatch_time && !raid.egg_hatched) {
						raid.egg_hatched = true;

						this.persistRaid(raid);

						this.refreshStatusMessages(raid)
							.catch(err => console.error(err));
					}
					if (raid.start_time) {
						if (raid.start_clear_time && (now > raid.start_clear_time)) {
							// clear out start time
							delete raid.start_time;
							delete raid.start_clear_time;

							this.persistRaid(raid);

							this.refreshStatusMessages(raid)
								.catch(err => console.error(err));

							// ask members if they finished raid
							this.setPresentAttendeesToComplete(channel_id)
								.catch(err => console.error(err));
						} else if (!raid.start_clear_time && now > raid.start_time) {
							raid.start_clear_time = start_clear_time;

							this.persistRaid(raid);

							this.refreshStatusMessages(raid)
								.catch(err => console.error(err));
						}
					}
					if (((raid.end_time !== EndTimeType.UNDEFINED_END_TIME && now > raid.end_time) || now > raid.last_possible_time) &&
						!raid.deletion_time) {
						// raid's end time is set and in the past or its last possible time has passed,
						// so schedule its deletion and send a warning message saying raid channel will
						// be deleted
						raid.deletion_time = deletion_time;

						this.persistRaid(raid);

						this.getChannel(raid.channel_id)
							.then(channel => channel.send(`**WARNING** - this channel will be deleted automatically at ${moment(deletion_time).format('h:mm a')}!`))
							.catch(err => console.error(err));
					}
					if (raid.deletion_time && (now > raid.deletion_time)) {
						// actually delete the channel and announcement message
						if (raid.announcement_message) {
							this.getMessage(raid.announcement_message)
								.then(message => message.delete())
								.catch(err => console.error(err));
						}

						this.getChannel(channel_id)
							.then(channel => channel.delete())
							.catch(err => console.error(err));

						// delete messages from raid object before moving to completed raid
						// storage as they're no longer needed
						delete raid.announcement_message;
						delete raid.messages;

						this.completed_raid_storage.getItem(raid.gym_id.toString())
							.then(gym_raids => {
								if (!gym_raids) {
									gym_raids = [];
								}
								gym_raids.push(raid);

								return Promise.resolve(
									this.completed_raid_storage.setItemSync(raid.gym_id.toString(), gym_raids));
							})
							.then(result => this.active_raid_storage.removeItemSync(channel_id))
							.catch(err => console.error(err));

						delete this.raids[channel_id];
					}
				});
		}, settings.cleanup_interval);
	}

	async getMember(channel_id, member_id) {
		return this.guild.fetchMember(member_id)
			.catch(err => {
				console.warn(`Removing non-existent member ${member_id} from raid`);
				this.removeAttendee(channel_id, member_id);
				throw err;
			})
	}

	getChannel(channel_id) {
		const channel = this.guild.channels.get(channel_id);

		if (!channel) {
			if (this.validRaid(channel_id)) {
				console.warn(`Deleting raid for nonexistent channel ${channel_id}`);

				const announcement_message = this.getRaid(channel_id).announcement_message;

				if (!!announcement_message) {
					this.getMessage(announcement_message)
						.then(message => message.delete())
						.catch(err => console.error(err));
				}

				this.active_raid_storage.removeItemSync(channel_id);
				delete this.raids[channel_id];
			}

			return Promise.reject(new Error('Channel does not exist'));
		}

		return Promise.resolve(channel);
	}

	async getMessage(message_cache_id) {
		const [channel_id, message_id] = message_cache_id.split(':');

		return this.getChannel(channel_id)
			.then(channel => channel.fetchMessage(message_id))
			.catch(err => {
				console.error(err);
				const raid = this.getRaid(channel_id);

				if (!!raid) {
					console.warn(`Deleting non-existent message ${message_id} from raid ${channel_id}`);
					raid.messages.splice(raid.messages.indexOf(message_cache_id), 1);

					this.persistRaid(raid);
				} else {
					// try to find raid announcement message that matches this message since that's what this non-existent message
					// most likely is
					Object.values(this.raids)
						.filter(raid => raid.announcement_message === message_cache_id)
						.forEach(raid => {
							console.warn(`Deleting non-existent announcement_message ${message_id} from raid ${raid.channel_id}`);
							delete raid.announcement_message;

							this.persistRaid(raid);
						});
				}

				return Promise.reject(new Error('Message does not exist'));
			});
	}

	shutdown() {
		this.client.destroy();
	}

	persistRaid(raid) {
		this.active_raid_storage.setItemSync(raid.channel_id, raid);
	}

	setClient(client, guild) {
		this.client = client;
		this.guild = guild;

		const
			roles = new Map(guild.roles.map(role => [role.name.toLowerCase(), role])),
			emojis = new Map(guild.emojis.map(emoji => [emoji.name.toLowerCase(), emoji.toString()]));

		this.roles.mystic = roles.get('mystic');
		this.roles.valor = roles.get('valor');
		this.roles.instinct = roles.get('instinct');
		this.roles.admin = roles.get('admin');
		this.roles.moderator = roles.get('moderator') || roles.get('mod');

		this.emojis.mystic = emojis.get('mystic') || '';
		this.emojis.valor = emojis.get('valor') || '';
		this.emojis.instinct = emojis.get('instinct') || '';

		this.emojis.pokeball = emojis.get('pokeball') || '';
		this.emojis.greatball = emojis.get('greatball') || '';
		this.emojis.ultraball = emojis.get('ultraball') || '';
		this.emojis.masterball = emojis.get('masterball') || '';
		this.emojis.premierball = emojis.get('premierball') || '';
	}

	createRaid(channel_id, member_id, pokemon, gym_id, end_time) {
		const raid = Object.create(null);

		// add some extra raid data to remember
		raid.created_by_id = member_id;
		raid.source_channel_id = channel_id;
		raid.creation_time = moment().valueOf();
		raid.last_possible_time = raid.creation_time + (settings.default_raid_duration * 60 * 1000);

		raid.pokemon = pokemon;
		raid.gym_id = gym_id;

		raid.attendees = Object.create(Object.prototype);
		raid.attendees[member_id] = {number: 1, status: Constants.RaidStatus.INTERESTED};

		const channel_name = Raid.generateChannelName(raid);

		return this.getChannel(channel_id)
			.then(channel => channel.clone(channel_name, true, false))
			.then(new_channel => {
				this.raids[new_channel.id] = raid;

				raid.channel_id = new_channel.id;
				if (end_time === EndTimeType.UNDEFINED_END_TIME) {
					raid.end_time = EndTimeType.UNDEFINED_END_TIME;
					this.persistRaid(raid);
				} else {
					this.setRaidEndTime(new_channel.id, end_time);
				}

				return {raid: raid};
			});
	}

	validRaid(channel_id) {
		return !!this.raids[channel_id];
	}

	getRaid(channel_id) {
		return this.raids[channel_id];
	}

	getAllRaids(channel_id) {
		return Object.values(this.raids)
			.filter(raid => raid.source_channel_id === channel_id);
	}

	getAttendeeCount(raid) {
		return Object.values(raid.attendees)
		// complete attendees shouldn't count
			.filter(attendee => attendee.status !== Constants.RaidStatus.COMPLETE)
			.map(attendee => attendee.number)
			.reduce((total, number) => total + number, 0);
	}

	setAnnouncementMessage(channel_id, message) {
		const raid = this.getRaid(channel_id);

		raid.announcement_message = `${raid.source_channel_id.toString()}:${message.id.toString()}`;

		this.persistRaid(raid);

		return message.pin();
	}

	addMessage(channel_id, message, pin = false) {
		const raid = this.getRaid(channel_id);

		if (!raid.messages) {
			raid.messages = [];
		}

		const message_cache_id = `${channel_id.toString()}:${message.id.toString()}`;

		raid.messages.push(message_cache_id);

		this.persistRaid(raid);

		if (pin) {
			return message.pin();
		}
	}

	removeAttendee(channel_id, member_id) {
		const raid = this.getRaid(channel_id),
			attendee = raid.attendees[member_id];

		if (!attendee) {
			return {error: 'You are not signed up for this raid.'};
		}

		delete raid.attendees[member_id];

		this.persistRaid(raid);

		return {raid: raid};
	}

	setMemberStatus(channel_id, member_id, status, additional_attendees = NaturalArgumentType.UNDEFINED_NUMBER) {
		const raid = this.getRaid(channel_id),
			attendee = raid.attendees[member_id],
			number = (additional_attendees !== NaturalArgumentType.UNDEFINED_NUMBER)
				? 1 + additional_attendees
				: 1;

		if (!attendee) {
			raid.attendees[member_id] = {
				number: number,
				status: status
			}
		} else {
			if (status === Constants.RaidStatus.INTERESTED &&
				(additional_attendees === NaturalArgumentType.UNDEFINED_NUMBER || attendee.number === number)) {
				return {error: 'You are already signed up for this raid.'};
			}

			if (additional_attendees !== NaturalArgumentType.UNDEFINED_NUMBER) {
				attendee.number = number;
			}
			attendee.status = status;
		}

		this.persistRaid(raid);

		return {raid: raid};
	}

	async setPresentAttendeesToComplete(channel_id, member_id) {
		const raid = this.getRaid(channel_id);

		if (!!member_id) {
			// set member that issued this command to complete
			this.setMemberStatus(channel_id, member_id, Constants.RaidStatus.COMPLETE);
			this.refreshStatusMessages(raid)
				.catch(err => console.error(err));
		}

		const channel = await this.getChannel(channel_id)
				.catch(err => console.error(err)),
			member_ids = Object.keys(raid.attendees)
				.filter(attendee_id => attendee_id !== member_id),
			members = await Promise.all(member_ids
				.map(async attendee_id => await this.getMember(channel_id, attendee_id)))
				.catch(err => console.error(err)),
			filtered_members = members
				.filter(member => raid.attendees[member.id].status === Constants.RaidStatus.PRESENT),
			questions = filtered_members
				.map(member => member.send(`Have you completed raid ${channel.toString()}?`));

		questions.forEach(async question =>
			question
				.then(async message => {
					const responses = await message.channel.awaitMessages(
						response => response.author.id === message.channel.recipient.id, {
							maxMatches: 1,
							time: settings.raid_complete_timeout * 60 * 1000
						})
						.catch(err => console.error(err));

					let confirmation, response;

					if (responses && responses.size === 1) {
						response = responses.first();
						confirmation = this.client.registry.types.get('boolean').truthy.has(response.content);
					} else {
						confirmation = false;
					}

					if (confirmation) {
						response.react('👍')
							.catch(err => console.error(err));

						raid.attendees[message.channel.recipient.id].status = Constants.RaidStatus.COMPLETE;
						this.persistRaid(raid);
						this.refreshStatusMessages(raid)
							.catch(err => console.error(err));
					}

					return true;
				})
				.catch(err => console.error(err)));
	}

	setRaidStartTime(channel_id, start_time) {
		const raid = this.getRaid(channel_id),
			now = moment();

		if (!!raid.pokemon.name) {
			raid.start_time = now.add(start_time, 'milliseconds').valueOf();
		} else {
			// this is an egg - start time means when the egg hatches instead
			raid.hatch_time = now.clone().add(start_time, 'milliseconds').valueOf();
			start_time += (settings.hatched_egg_duration * 60 * 1000);

			raid.end_time = now.add(start_time, 'milliseconds').valueOf();
		}

		this.persistRaid(raid);

		return {raid: raid};
	}

	setRaidEndTime(channel_id, end_time) {
		const raid = this.getRaid(channel_id),
			now = moment();

		if (!raid.pokemon.name) {
			// this is an egg, so the end time is indeed actually its hatch time
			raid.hatch_time = now.clone().add(end_time, 'milliseconds').valueOf();
			end_time += (settings.hatched_egg_duration * 60 * 1000);
		}

		raid.end_time = now.add(end_time, 'milliseconds').valueOf();

		this.persistRaid(raid);

		return {raid: raid};
	}

	setRaidPokemon(channel_id, pokemon) {
		const raid = this.getRaid(channel_id);

		if (!!raid.hatch_time && !!pokemon.name) {
			// clear hatch time from raid since egg is being replace with
			// actual raid boss
			delete raid.hatch_time;
		}
		raid.pokemon = pokemon;

		this.persistRaid(raid);

		const new_channel_name = Raid.generateChannelName(raid);

		this.getChannel(channel_id)
			.then(channel => channel.setName(new_channel_name))
			.catch(err => console.error(err));

		return {raid: raid};
	}

	setRaidLocation(channel_id, gym_id) {
		const raid = this.getRaid(channel_id);
		raid.gym_id = gym_id;

		this.persistRaid(raid);

		const new_channel_name = Raid.generateChannelName(raid);

		this.getChannel(channel_id)
			.then(channel => channel.setName(new_channel_name))
			.catch(err => console.error(err));

		return {raid: raid};
	}

	async getRaidsFormattedMessage(channel_id) {
		const raids = this.getAllRaids(channel_id);

		if (!raids || raids.length === 0) {
			return 'No raids exist for this channel.  Create one with \`!raid\`!';
		}

		const raid_strings = await Promise.all(raids
			.map(async raid => await this.getRaidShortMessage(raid))),
			filtered_raid_strings = raid_strings
				.filter(raid_string => {
					return raid_string !== '';
				});

		if (filtered_raid_strings.length === 0) {
			return 'No raids exist for this channel.  Create one with \`!raid\`!';
		}

		return filtered_raid_strings.join('\n');
	}

	getRaidShortMessage(raid) {
		const pokemon = raid.pokemon.name ?
			raid.pokemon.name.charAt(0).toUpperCase() + raid.pokemon.name.slice(1) :
			'????',
			total_attendees = this.getAttendeeCount(raid),
			gym = Gym.getGym(raid.gym_id).gymName;

		return this.getChannel(raid.channel_id)
			.then(channel => `**${pokemon}**\n` +
				`${channel.toString()} :: ${gym} :: ${total_attendees} interested trainer${total_attendees !== 1 ? 's' : ''}\n`)
			.catch(err => {
				console.error(err);
				return '';
			});
	}

	getRaidChannelMessage(raid) {
		return this.getChannel(raid.channel_id)
			.then(channel => `Use ${channel.toString()} for the following raid:`)
			.catch(err => console.error(err));
	}

	getRaidSourceChannelMessage(raid) {
		return this.getChannel(raid.source_channel_id)
			.then(channel => `Use ${channel.toString()} to return to this raid\'s regional channel.`)
			.catch(err => console.error(err));
	}

	async getFormattedMessage(raid) {
		const pokemon = !!raid.pokemon.name ?
			raid.pokemon.name.charAt(0).toUpperCase() + raid.pokemon.name.slice(1) :
			'????',
			tier = raid.pokemon.tier,

			end_time = raid.end_time !== EndTimeType.UNDEFINED_END_TIME ?
				`Raid available until ${moment(raid.end_time).format('h:mm a')}` :
				'Raid end time currently unset',
			now = moment(),
			start_time = !!raid.start_time ?
				moment(raid.start_time) :
				'',
			start_label = !!raid.start_time ?
				now > start_time ?
					'__Last Starting Time__' :
					'__Next Planned Starting Time__'
				: '',
			hatch_time = !!raid.hatch_time ?
				moment(raid.hatch_time) :
				'',
			hatch_label = !!raid.hatch_time ?
				now > hatch_time ?
					'__Egg Hatched At__' :
					'__Egg Hatch Time__' :
				'',

			gym = Gym.getGym(raid.gym_id),
			gym_name = !!gym.nickname ?
				gym.nickname :
				gym.gymName,
			gym_url = `https://www.google.com/maps/dir/Current+Location/${gym.gymInfo.latitude},${gym.gymInfo.longitude}`,
			additional_information = !!gym.additional_information ?
				gym.additional_information :
				'',

			total_attendees = this.getAttendeeCount(raid),
			attendee_entries = Object.entries(raid.attendees),
			attendees_with_members = await Promise.all(attendee_entries
				.map(async attendee_entry => [await this.getMember(raid.channel_id, attendee_entry[0]), attendee_entry[1]])),
			sorted_attendees = attendees_with_members
				.sort((entry_a, entry_b) => {
					const name_a = entry_a[0].displayName,
						name_b = entry_b[0].displayName;

					return name_a.localeCompare(name_b);
				}),

			interested_attendees = sorted_attendees
				.filter(attendee_entry => attendee_entry[1].status === Constants.RaidStatus.INTERESTED),
			coming_attendees = sorted_attendees
				.filter(attendee_entry => attendee_entry[1].status === Constants.RaidStatus.COMING),
			present_attendees = sorted_attendees
				.filter(attendee_entry => attendee_entry[1].status === Constants.RaidStatus.PRESENT),
			complete_attendees = sorted_attendees
				.filter(attendee_entry => attendee_entry[1].status === Constants.RaidStatus.COMPLETE),

			attendees_builder = (attendees_list, emoji) => {
				let result = '';

				attendees_list.forEach(([member, attendee]) => {
					result += emoji + ' ' + member.displayName;

					// show how many additional attendees this user is bringing with them
					if (attendee.number > 1) {
						result += ' +' + (attendee.number - 1);
					}

					// add role emoji indicators if role exists
					if (this.roles.mystic && member.roles.has(this.roles.mystic.id)) {
						result += ' ' + this.emojis.mystic;
					} else if (this.roles.valor && member.roles.has(this.roles.valor.id)) {
						result += ' ' + this.emojis.valor;
					} else if (this.roles.instinct && member.roles.has(this.roles.instinct.id)) {
						result += ' ' + this.emojis.instinct;
					}

					result += '\n';
				});

				return result;
			};

		const embed = new Discord.RichEmbed()
			.setColor(4437377)
			.setThumbnail(`https://rankedboost.com/wp-content/plugins/ice/pokemon-go/${pokemon}-Pokemon-Go.png`)
			.setTitle(gym_name)
			.setURL(gym_url)
			.setDescription(`Level ${tier} Raid against ${pokemon}`);

		if (end_time !== '') {
			embed.setFooter(end_time);
		}

		if (total_attendees > 0) {
			embed.addField('__Possible Trainers__', total_attendees.toString());
		}
		if (interested_attendees.length > 0) {
			embed.addField('Interested', attendees_builder(interested_attendees, this.emojis.pokeball), true);
		}
		if (coming_attendees.length > 0) {
			embed.addField('Coming', attendees_builder(coming_attendees, this.emojis.greatball), true);
		}
		if (present_attendees.length > 0) {
			embed.addField('Present', attendees_builder(present_attendees, this.emojis.ultraball), true);
		}
		if (complete_attendees.length > 0) {
			embed.addField('Complete', attendees_builder(complete_attendees, this.emojis.premierball), true);
		}

		if (!!raid.hatch_time) {
			embed.addField(hatch_label, hatch_time.format('h:mm a'));
		}

		if (!!raid.start_time) {
			embed.addField(start_label, start_time.format('h:mm a'));
		}

		if (additional_information !== '') {
			embed.addField('**Location Information**', additional_information);
		}

		return {embed};
	}

	async refreshStatusMessages(raid) {
		const raid_channel_message = await this.getRaidChannelMessage(raid),
			raid_source_channel_message = await this.getRaidSourceChannelMessage(raid),
			formatted_message = await
				this.getFormattedMessage(raid);

		if (raid.announcement_message) {
			this.getMessage(raid.announcement_message)
				.then(announcement_message => announcement_message.edit(raid_channel_message, formatted_message))
				.catch(err => console.error(err));
		}

		raid.messages
			.forEach(message_cache_id => {
				this.getMessage(message_cache_id)
					.then(message => message.edit(raid_source_channel_message, formatted_message))
					.catch(err => console.error(err));
			});
	}

	raidExistsForGym(gym_id) {
		return Object.values(this.raids)
			.map(raid => raid.gym_id)
			.filter(raid_gym_id => raid_gym_id === gym_id)
			.length > 0;
	}

	getCreationChannelName(channel_id) {
		return this.validRaid(channel_id) ?
			this.getChannel(this.getRaid(channel_id).source_channel_id)
				.then(channel => channel.name)
				.catch(err => {
					console.error(err);
					return '';
				}) :
			this.getChannel(channel_id)
				.then(channel => channel.name)
				.catch(err => {
					console.error(err);
					return '';
				});
	}

	static generateChannelName(raid) {
		const nonCharCleaner = new RegExp(/[^\w]/, 'g'),
			pokemon_name = (!!raid.pokemon.name ?
				raid.pokemon.name :
				('tier ' + raid.pokemon.tier))
				.replace(nonCharCleaner, ' ')
				.split(' ')
				.filter(token => token.length > 0)
				.join('-'),
			gym = Gym.getGym(raid.gym_id),
			gym_name = (!!gym.nickname ?
				gym.nickname :
				gym.gymName)
				.toLowerCase()
				.replace(nonCharCleaner, ' ')
				.split(' ')
				.filter(token => token.length > 0)
				.join('-');

		return pokemon_name + '-' + gym_name;
	}
}

module.exports = new Raid();
