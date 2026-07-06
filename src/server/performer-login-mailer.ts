type MailerEnv = Record<string, string | undefined>;

export function resolvePerformerLoginBaseUrl(env: MailerEnv) {
  const localPort = env.PORT?.trim() || '3000';

  return env.SWAY_APP_BASE_URL?.trim()
    || env.APP_URL?.trim()
    || (env.NODE_ENV === 'production' ? 'https://app.sway.tips' : `http://localhost:${localPort}`);
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
    const provider = env.SWAY_EMAIL_PROVIDER?.trim().toLowerCase() || '';
    const apiKey = env.SWAY_EMAIL_API_KEY?.trim() || '';
    const fromAddress = env.SWAY_EMAIL_FROM?.trim() || '';
    const appBaseUrl = resolvePerformerLoginBaseUrl(env).trim();

    if (!provider) {
      if (!isProduction) {
        console.log(`[SWAY_EMAIL_MOCK] ${subject} for ${toEmail}: ${link}`);
        return { delivered: true as const, provider: 'mock' as const };
      }

      console.error('Performer login email delivery unavailable: missing SWAY_EMAIL_PROVIDER.');
      return { delivered: false as const, provider: 'missing' };
    }

    if (!apiKey || !fromAddress || !appBaseUrl) {
      console.error('Performer login email delivery unavailable: missing SWAY_EMAIL_PROVIDER, SWAY_EMAIL_API_KEY, SWAY_EMAIL_FROM, or SWAY_APP_BASE_URL.');
      return { delivered: false as const, provider };
    }

    const bodyText = [
      introLine,
      '',
      link,
      '',
      'This link expires in 15 minutes.'
    ].join('\n');

    if (provider === 'resend') {
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
          text: bodyText
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

    if (provider === 'brevo') {
      const fromMatch = fromAddress.match(/^(.*)<(.+)>$/);
      const senderEmail = (fromMatch ? fromMatch[2] : fromAddress).trim();
      const senderName = (fromMatch ? fromMatch[1] : 'Sway').trim() || 'Sway';

      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: toEmail }],
          subject,
          textContent: bodyText
        })
      });

      if (!response.ok) {
        console.error('Performer login email delivery failed via Brevo.', {
          status: response.status,
          statusText: response.statusText
        });
        return { delivered: false as const, provider };
      }

      return { delivered: true as const, provider };
    }

    console.error(`Performer login email delivery unavailable: unsupported SWAY_EMAIL_PROVIDER "${provider}".`);
    return { delivered: false as const, provider };
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
