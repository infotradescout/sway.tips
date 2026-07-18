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
    headline: 'DJ3X · DJ · Live events · Entertainment',
    bio: 'All things entertainment. DJ3X brings live music, event energy, hosts, and the people behind the moment into one place.',
    specialties: ['DJ', 'Live events', 'Event host', 'Entertainment', 'Brand partnerships'],
    city: 'Pensacola, FL',
    facebookUrl: 'https://www.facebook.com/frank.broughton.507',
    links: [
      {
        label: 'Follow Broughton Frank',
        description: 'Entertainment, events, and live moments.',
        url: 'https://www.facebook.com/frank.broughton.507',
        kind: 'social',
        isActive: true
      }
    ]
  },
  {
    handle: 'coreymack',
    displayName: 'Corey Mack',
    headline: 'The Jester of Sound and Soul · DJ · Beatbox · Live performance',
    bio: 'Corey Mack blends DJ sets, beatboxing, live looping, and event hosting across hardware and software setups—including tablet-first workflows.',
    specialties: ['DJ', 'Beatboxing', 'Live looping', 'MC', 'Event host', 'Hardware + software'],
    websiteUrl: 'https://coreymack.us',
    links: [
      {
        label: 'Corey Mack online',
        description: 'Official home base for bookings and updates.',
        url: 'https://coreymack.us',
        kind: 'booking',
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
      preview.facebookUrl ?? null,
      preview.instagramUrl ?? null,
      preview.tiktokUrl ?? null,
      preview.youtubeUrl ?? null,
      preview.soundcloudUrl ?? null,
      preview.websiteUrl ?? null,
      JSON.stringify(preview.links)
    ];

    const updated = await client.query(
      `UPDATE performer_profile_previews
       SET handle = $1,
           display_name = $2,
           bio = $3,
           headline = $4,
           specialties = $5::jsonb,
           city = $6,
           facebook_url = $7,
           instagram_url = $8,
           tiktok_url = $9,
           youtube_url = $10,
           soundcloud_url = $11,
           website_url = $12,
           links = $13::jsonb,
           is_active = true,
           updated_at = now()
       WHERE lower(handle) = lower($1)
       RETURNING id`,
      values
    );

    if (updated.rowCount === 0) {
      const inserted = await client.query(
        `INSERT INTO performer_profile_previews
          (handle, display_name, bio, headline, specialties, city, facebook_url,
           instagram_url, tiktok_url, youtube_url, soundcloud_url, website_url, links)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
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
