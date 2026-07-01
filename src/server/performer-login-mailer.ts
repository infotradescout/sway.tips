type MailerEnv = Record<string, string | undefined>;

export function resolvePerformerLoginBaseUrl(env: MailerEnv) {
  return env.SWAY_APP_BASE_URL?.trim()
    || env.APP_URL?.trim()
    || 'http://localhost:3000';
}

export function createPerformerLoginMailer({
  env,
  isProduction
}: {
  env: MailerEnv;
  isProduction: boolean;
}) {
  async function deliverLink({
    toEmail,
    link,
    subject,
    introLine
  }: {
    toEmail: string;
    link: string;
    subject: string;
    introLine: string;
  }) {
    if (!isProduction) {
      console.log(`[SWAY_EMAIL_MOCK] ${subject} for ${toEmail}: ${link}`);
      return { delivered: true as const, provider: 'mock' as const };
    }

    const provider = env.SWAY_EMAIL_PROVIDER?.trim().toLowerCase() || '';
    const apiKey = env.SWAY_EMAIL_API_KEY?.trim() || '';
    const fromAddress = env.SWAY_EMAIL_FROM?.trim() || '';
    const appBaseUrl = resolvePerformerLoginBaseUrl(env).trim();

    if (!provider || !apiKey || !fromAddress || !appBaseUrl) {
      console.error('Performer login email delivery unavailable: missing SWAY_EMAIL_PROVIDER, SWAY_EMAIL_API_KEY, SWAY_EMAIL_FROM, or SWAY_APP_BASE_URL.');
      return { delivered: false as const, provider: provider || 'missing' };
    }

    if (provider !== 'resend') {
      console.error(`Performer login email delivery unavailable: unsupported SWAY_EMAIL_PROVIDER "${provider}".`);
      return { delivered: false as const, provider };
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [toEmail],
        subject,
        text: [
          introLine,
          '',
          link,
          '',
          'This link expires in 15 minutes.'
        ].join('\n')
      })
    });

    if (!response.ok) {
      console.error('Performer login email delivery failed via Resend.', {
        status: response.status,
        statusText: response.statusText
      });
      return { delivered: false as const, provider };
    }

    return { delivered: true as const, provider };
  }

  return {
    sendMagicLink({
      toEmail,
      magicLink
    }: {
      toEmail: string;
      magicLink: string;
    }) {
      return deliverLink({
        toEmail,
        link: magicLink,
        subject: 'Your Sway performer sign-in link',
        introLine: 'Open your secure Sway performer link on the device you want to use tonight.'
      });
    },

    sendVerificationLink({
      toEmail,
      verificationLink
    }: {
      toEmail: string;
      verificationLink: string;
    }) {
      return deliverLink({
        toEmail,
        link: verificationLink,
        subject: 'Verify your Sway performer account',
        introLine: 'Verify your Sway performer email so you can start live rooms with your account.'
      });
    }
  };
}
