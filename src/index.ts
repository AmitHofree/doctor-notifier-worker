import { WorkerEntrypoint } from 'cloudflare:workers';
import { Bot, CommandContext, Context, webhookCallback } from 'grammy'; 

interface Env {
	BOT_INFO: string;
	TELEGRAM_BOT_TOKEN: string;
	DB: D1Database;
}


export class DoctorNotifierWorker extends WorkerEntrypoint<Env> {
	bot: Bot;

	constructor(ctx: ExecutionContext, env: Env) {
		super(ctx, env);
		const botInfo = JSON.parse(env.BOT_INFO);
		const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
		this.bot = bot;
	}

	async checkAndNotify(itemKeyIdentifier: string) {
		const newAppointmentDate = await fetchNewAppointmentDate(itemKeyIdentifier);
		const lastAppointmentDate = await fetchOldAppointmentDate(itemKeyIdentifier);

		if (newAppointmentDate && newAppointmentDate !== lastAppointmentDate) {
			console.log(`New appointment date found: ${newAppointmentDate}`);
			const isWithinNextDays = isAppointmentWithinNextDays(newAppointmentDate, 60);

			if (isWithinNextDays) {
				console.log('Appointment is within the next 60 days, notifying users');
				await notifyUsers(
					`New available appointment date: ${newAppointmentDate}\nSchedule an appointment using the link: ${env.APPOINTMENT_URL}`,
					env
				);
				await env.STORAGE.put('last_appointment_date', newAppointmentDate);
			} else {
				console.log('New appointment date is not within the next 60 days');
			}
		} else {
			console.log('No new appointment date or no change');
		}
	}
}

async function fetchNewAppointmentDate(itemKeyIdentifier: string): Promise<Date> {
	const maxAttempts = 3;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(appointmentUrl, {
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
				throw new Error('Initial state match not found in webpage content.');
			}

			const initialStateStr = initialStateMatch[1];
			const data = JSON.parse(initialStateStr);
			const fullDateStr = data?.info?.infoResults?.AppointmentDateTime;
			if (!fullDateStr) {
				// Acceptable state
				return null;
			}

			const dateMatch = fullDateStr.match(/\d{2}\/\d{2}\/\d{2,4}/);
			if (!dateMatch) {
				throw new Error('Appointment date format is incorrect or missing.');
			}

			return dateMatch[0];
		} catch (error) {
			if (error instanceof Error)
				console.error(`Attempt ${attempt} failed: ${error.message}`);
			else 
				console.error(`Attempt ${attempt} failed: ${error}`)
			// Optionally, wait before retrying
			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1 second
			}
		}
	}
	throw new Error('All attempts to fetch the webpage have failed.');
}

async function fetchOldAppointmentDate(itemKeyIdentifier: string): Promise<Date> {}


function isAppointmentWithinNextDays(appointmentDateStr, days = 60) {
	const appointmentDate = new Date(appointmentDateStr);
	const today = new Date();
	const daysLater = new Date(today);
	daysLater.setDate(daysLater.getDate() + days);

	return appointmentDate >= today && appointmentDate <= daysLater;
}


async function notifyUsers(message, env) {
	const activeChatIdsJson = await env.STORAGE.get('active_chat_ids');
	if (!activeChatIdsJson) return;

	const activeChatIds = JSON.parse(activeChatIdsJson);
	for (const chatId of activeChatIds) {
		await sendMessage(chatId, message, env.TELEGRAM_BOT_TOKEN);
	}
}

async function sendMessage(chatId, text, telegramBotToken) {
	await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text: text,
		}),
	});
}
