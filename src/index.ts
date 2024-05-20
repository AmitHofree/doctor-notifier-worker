import { WorkerEntrypoint } from 'cloudflare:workers';
import { Bot } from 'grammy';

type NotificationsRegisteredRow = {
	chat_id: number;
	item_key_index: string;
};

interface Env {
	BOT_INFO: string;
	TELEGRAM_BOT_TOKEN: string;
	DB: D1Database;
}

const TIME_WINDOW = 60;

export default class extends WorkerEntrypoint<Env> {
	private bot: Bot;

	constructor(ctx: ExecutionContext, env: Env) {
		super(ctx, env);
		const botInfo = JSON.parse(env.BOT_INFO);
		const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
		this.bot = bot;
	}

	public async fetch() {
		return new Response('OK');
	}

	public async checkAndNotify(itemKeyIndex: string) {
		console.log(`Received request for ${itemKeyIndex}`);
		const newAppointmentDate = await this.fetchNewAppointmentDate(itemKeyIndex);
		const lastAppointmentDate = await this.fetchOldAppointmentDate(itemKeyIndex);

		if (newAppointmentDate && newAppointmentDate.getTime() !== lastAppointmentDate?.getTime()) {
			console.log(`New appointment date found: ${newAppointmentDate}`);
			const isWithinNextDays = isDateWithinNextDays(newAppointmentDate, TIME_WINDOW);

			if (isWithinNextDays) {
				console.log(`Appointment is within the next ${TIME_WINDOW} days, notifying users`);
				await this.notifyUsers(itemKeyIndex, newAppointmentDate);
				await this.saveAppointmentDate(itemKeyIndex, newAppointmentDate);
			} else {
				console.log('New appointment date is not within the next 60 days');
			}
		} else {
			console.log('No new appointment date or no change');
		}
	}

	private async fetchOldAppointmentDate(itemKeyIndex: string): Promise<Date | null> {
		try {
			const stmt = this.env.DB.prepare('SELECT * FROM notification_date WHERE item_key_index = ?').bind(itemKeyIndex);
			const lastNotificationDate = await stmt.first<string>('last_notification_date');
			if (!lastNotificationDate) return null;
			return new Date(Date.parse(lastNotificationDate));
		} catch (e) {
			console_error('Error executing SQL query in fetchOldAppointmentDate', e);
			return null;
		}
	}

	private async fetchNewAppointmentDate(itemKeyIndex: string): Promise<Date | null> {
		const maxAttempts = 3;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const response = await fetch(generateAppointmentUrl(itemKeyIndex), {
					headers: {
						'User-Agent':
							'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
						Accept:
							'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
						'Accept-Language': 'en-US,en;q=0.9',
					},
				});

				const text = await response.text();

				if (!response.ok) {
					throw new Error(`Failed to fetch webpage. Status: ${response.status}. Text: ${text}`);
				}

				// Process the successful response outside the retry loop
				const initialStateMatch = text.match(/window\.__INITIAL_STATE__ = ({.*?})\s*;/s);
				if (!initialStateMatch) {
					throw new Error('Initial state match not found in webpage content');
				}

				const initialStateStr = initialStateMatch[1];
				const data = JSON.parse(initialStateStr);
				const fullDateStr = data?.info?.infoResults?.AppointmentDateTime;
				if (!fullDateStr) {
					// Acceptable state
					return null;
				}

				const dateMatch = fullDateStr.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
				if (!dateMatch) {
					throw new Error('Appointment date format is incorrect or missing');
				}
				const [_, day, month, year] = dateMatch;
				return new Date(2000 + Number(year), Number(month) - 1, Number(day));
			} catch (error) {
				console_error(`Attempt ${attempt} failed: `, error);
				// Optionally, wait before retrying
				if (attempt < maxAttempts) sleep(1);
			}
		}
		throw new Error('Failed fetching the new appointment date');
	}

	private async saveAppointmentDate(itemKeyIndex: string, appointmentDate: Date) {
		const dateString = appointmentDate.toISOString();
		try {
			const stmt = this.env.DB.prepare(
				'INSERT INTO notification_date (item_key_index, last_notification_date) VALUES (?, ?) ON CONFLICT (item_key_index) DO UPDATE SET last_notification_date = ?'
			).bind(itemKeyIndex, dateString, dateString);
			const { success } = await stmt.run();
			if (!success) {
				console.log('Unknown error executing SQL query in saveAppointmentDate');
			}
		} catch (e) {
			console_error('Error executing SQL query in saveAppointmentDate', e);
		}
	}

	private async fetchRegisteredUsers(itemKeyIndex: string): Promise<number[]> {
		try {
			const stmt = this.env.DB.prepare('SELECT * FROM notifications_registered WHERE item_key_index = ?').bind(itemKeyIndex);
			const { results, success } = await stmt.all<NotificationsRegisteredRow>();
			if (!success) {
				console.log('Unknown error executing SQL query in fetchRegisteredUsers');
				return [];
			}
			return results.map((result) => result.chat_id);
		} catch (e) {
			console_error('Error executing SQL query in fetchRegisteredUsers', e);
			return [];
		}
	}

	private async notifyUsers(itemKeyIndex: string, appointmentDate: Date) {
		const appointmentLink = generateAppointmentUrl(itemKeyIndex);
		const appointmentDateString = appointmentDate.toISOString();
		const registeredUsers = await this.fetchRegisteredUsers(itemKeyIndex);
		await Promise.all(
			registeredUsers.map((user) =>
				this.bot.api.sendMessage(
					user,
					`New available appointment date: ${appointmentDateString}\nSchedule an appointment using the link: ${appointmentLink}`
				)
			)
		);
	}
}

function isDateWithinNextDays(date: Date, days: number): boolean {
	const today = new Date();
	const daysLater = new Date(today);
	daysLater.setDate(daysLater.getDate() + days);
	return date >= today && date <= daysLater;
}

function generateAppointmentUrl(itemKeyIndex: string): string {
	return `https://serguide.maccabi4u.co.il/heb/doctors/doctorssearchresults/doctorsinfopage/?ItemKeyIndex=${itemKeyIndex}`;
}

function console_error(message: string, e: any) {
	if (e instanceof Error) {
		console.error(`${message} ${e.message}`);
	} else {
		console.error(`${message} ${e}`);
	}
}

async function sleep(secs: number) {
	await new Promise((resolve) => setTimeout(resolve, secs * 1000));
}
