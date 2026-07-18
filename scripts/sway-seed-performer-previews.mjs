import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to seed performer profile previews.');
}

// These are curated, public-facing previews only. They intentionally contain
// no email, phone, password, owner id, invitation token, or terms acceptance.
const previews = [
  {
    handle: 'dj3x',
    displayName: 'Broughton Frank',
    metadata: { stageName: 'DJ3X' },
    headline: 'DJ Three X · Crowd-first DJ · Sound design · Event energy',
    bio: 'Frank Broughton, known as DJ Three X, is a Pensacola DJ and sound designer whose crowd-first sets blend throwbacks, R&B, hip-hop, and whatever the room is ready for. Performing since 1992, he also brings live-event and media-production experience through Vybe Café.',
    specialties: ['DJ', 'Sound design', 'Event consulting', 'Event host', 'Live events', 'R&B + hip-hop', 'Brand partnerships'],
    city: 'Pensacola, FL',
    // Supplied from Frank's public Facebook profile image; stored locally so
    // the public page does not depend on a third-party hotlink.
    avatarUrl: '/assets/frank-broughton-avatar.png',
    facebookUrl: 'https://www.facebook.com/frank.broughton.507',
    websiteUrl: 'https://djthreeex.com',
    links: [
      {
        label: 'DJ Three X website',
        description: 'DJ services, sound design, and consulting.',
        url: 'https://djthreeex.com',
        kind: 'booking',
        isActive: true
      },
      {
        label: 'Profile interview: Taking A Spin With DJ Three X',
        description: 'A published conversation about his craft, roots, and crowd-first approach.',
        url: 'https://www.kinanddignity.com/blog/taking-a-spin-with-dj-three-x',
        kind: 'press',
        isActive: true
      },
      {
        label: 'Follow Broughton Frank',
        description: 'Entertainment, events, and live moments.',
        url: 'https://www.facebook.com/frank.broughton.507',
        kind: 'social',
        isActive: true
      }
    ],
    featuredMedia: []
  },
  {
    handle: 'coreymack',
    displayName: 'Corey Mack',
    metadata: { stageName: 'Corey Mack' },
    headline: 'The Jester of Sound and Soul',
    bio: 'A one-man festival blending beatboxing, DJ sets, stand-up, live looping, MC work, and high-energy event hosting. More than 15 years of rhythm, laughter, and connection.',
    specialties: ['Beatbox', 'DJ', 'Stand-up comedy', 'Live looping', 'MC', 'Event host'],
    avatarUrl: 'https://img1.wsimg.com/isteam/ip/507cdd9e-ba65-48f1-ac5c-290e6c33023b/72E6855B-ABEB-492D-8EA4-0DAB48CAA65E.jpeg',
    facebookUrl: 'https://www.facebook.com/SillyShaman',
    instagramUrl: 'https://www.instagram.com/coreymackthejester',
    websiteUrl: 'https://coreymack.us',
    links: [
      {
        label: 'Book Corey Mack',
        description: 'Booking details and the full Corey Mack story.',
        url: 'https://coreymack.us',
        kind: 'booking',
        isActive: true
      },
      {
        label: 'Follow the Jester',
        description: 'Beatbox, comedy, DJ, and live performance updates.',
        url: 'https://www.instagram.com/coreymackthejester',
        kind: 'social',
        isActive: true
      },
      {
        label: 'Corey Mack on Facebook',
        description: 'Shows, clips, and event announcements.',
        url: 'https://www.facebook.com/SillyShaman',
        kind: 'social',
        isActive: true
      }
    ],
    featuredMedia: [
      {
        kind: 'youtube',
        title: 'Kita P x Corey Mack in New Orleans',
        description: 'Say yes — beatbox cover.',
        url: 'https://www.youtube.com/watch?v=--7MMybc6Vw',
        isActive: true
      }
    ]
  }
];

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query('BEGIN');
  const seeded = [];

  for (const preview of previews) {
    const values = [
      preview.handle,
      preview.displayName,
      preview.bio,
      preview.headline,
      JSON.stringify(preview.specialties),
      preview.city ?? null,
      preview.avatarUrl ?? null,
      preview.facebookUrl ?? null,
      preview.instagramUrl ?? null,
      preview.tiktokUrl ?? null,
      preview.youtubeUrl ?? null,
      preview.soundcloudUrl ?? null,
      preview.websiteUrl ?? null,
      JSON.stringify(preview.links),
      JSON.stringify(preview.featuredMedia),
      JSON.stringify(preview.metadata ?? {})
    ];

    const updated = await client.query(
      `UPDATE performer_profile_previews
       SET handle = $1,
           display_name = $2,
           bio = $3,
           headline = $4,
           specialties = $5::jsonb,
           city = $6,
           avatar_url = $7,
           facebook_url = $8,
           instagram_url = $9,
           tiktok_url = $10,
           youtube_url = $11,
           soundcloud_url = $12,
           website_url = $13,
           links = $14::jsonb,
           featured_media = $15::jsonb,
           metadata = $16::jsonb,
           is_active = true,
           updated_at = now()
       WHERE lower(handle) = lower($1)
       RETURNING id`,
      values
    );

    if (updated.rowCount === 0) {
      const inserted = await client.query(
        `INSERT INTO performer_profile_previews
          (handle, display_name, bio, headline, specialties, city, avatar_url, facebook_url,
           instagram_url, tiktok_url, youtube_url, soundcloud_url, website_url, links, featured_media, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb)
         RETURNING id`,
        values
      );
      seeded.push({ handle: preview.handle, action: 'inserted', id: inserted.rows[0].id });
    } else {
      seeded.push({ handle: preview.handle, action: 'updated', id: updated.rows[0].id });
    }
  }

  await client.query('COMMIT');
  console.log(JSON.stringify({ seeded }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
