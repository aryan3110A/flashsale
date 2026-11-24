const IMG = (id) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1200&q=70`;
const DAY = 86_400_000;

// Dates are relative to first seed so the catalogue is always "upcoming". Rows are keyed by slug and
// inserted with ON CONFLICT DO NOTHING, so restarting never resets inventory or overwrites edits.
const EVENTS = [
  { slug: 'neon-nights-festival', title: 'Neon Nights Festival', category: 'Music', venue: 'Riverfront Grounds', city: 'Ahmedabad', days: 18, hour: 18, price: 2499, capacity: 1200, featured: true, image: '1470229722913-7c0e2dbbafd3',
    description: 'Three stages, twelve artists and a laser-lit skyline. Neon Nights is the city\'s biggest open-air electronic and indie festival, running from sunset to the early hours.' },
  { slug: 'design-futures-summit', title: 'Design Futures Summit', category: 'Technology', venue: 'Convention Centre', city: 'Ahmedabad', days: 25, hour: 9, price: 899, capacity: 450, featured: true, image: '1540575467063-178a50c2df87',
    description: 'A one-day summit on product design, AI-assisted workflows and design systems at scale. Talks, live critiques and a hands-on workshop track.' },
  { slug: 'indie-sessions-unplugged', title: 'Indie Sessions: Unplugged', category: 'Music', venue: 'The Courtyard', city: 'Gandhinagar', days: 12, hour: 19, price: 499, capacity: 180, featured: false, image: '1511671782779-c97d3d27a1d4',
    description: 'An intimate, acoustic evening with five independent artists in a candle-lit courtyard. Limited seating, no amplification, all atmosphere.' },
  { slug: 'startup-after-hours', title: 'Startup After Hours', category: 'Networking', venue: 'Riverfront Studio', city: 'Ahmedabad', days: 32, hour: 17, price: 299, capacity: 300, featured: false, image: '1523580494863-6f3031224c94',
    description: 'Founders, engineers and investors in one room. Lightning pitches, open mic problem-solving and plenty of time to talk.' },
  { slug: 'future-of-play-expo', title: 'Future of Play Expo', category: 'Gaming', venue: 'Expo Centre', city: 'Ahmedabad', days: 40, hour: 10, price: 699, capacity: 800, featured: true, image: '1542751371-adc38448a05e',
    description: 'Play unreleased indie titles, meet the studios behind them and watch the regional esports finals on the main stage.' },
  { slug: 'sunrise-run-club', title: 'Sunrise Run Club 10K', category: 'Sports', venue: 'Sabarmati Promenade', city: 'Ahmedabad', days: 9, hour: 5, price: 199, capacity: 600, featured: false, image: '1452626038306-9aae5e071dd3',
    description: 'A timed 10K along the riverfront at first light, with pacers for every speed, hydration stations and a post-run breakfast.' },
  { slug: 'comedy-cellar-live', title: 'Comedy Cellar Live', category: 'Comedy', venue: 'Laugh Lounge', city: 'Mumbai', days: 14, hour: 20, price: 799, capacity: 220, featured: false, image: '1507676184212-d03ab07a01bf',
    description: 'Five stand-up comics, one headliner and a room built for laughing. Seating is first-come within your ticket tier.' },
  { slug: 'street-food-carnival', title: 'Street Food Carnival', category: 'Food', venue: 'Law Garden Grounds', city: 'Ahmedabad', days: 21, hour: 16, price: 149, capacity: 1500, featured: false, image: '1414235077428-338989a2e8c0',
    description: 'Sixty vendors, one weekend. Regional street food, chef demos and a night market with live folk music.' },
  { slug: 'ai-engineering-conf', title: 'AI Engineering Conference', category: 'Technology', venue: 'Tech Park Auditorium', city: 'Bengaluru', days: 47, hour: 9, price: 1999, capacity: 700, featured: true, image: '1505373877841-8d25f7d46678',
    description: 'Two days on building reliable LLM applications: evaluation, retrieval, agents in production and cost control. Talks from practising engineers.' },
  { slug: 'monsoon-jazz-night', title: 'Monsoon Jazz Night', category: 'Music', venue: 'Blue Room', city: 'Mumbai', days: 28, hour: 21, price: 1299, capacity: 260, featured: false, image: '1493225457124-a3eb161ffa5f',
    description: 'A quartet, a saxophone and the sound of rain. A late-night jazz set in one of the city\'s most loved small venues.' },
  { slug: 'city-cycling-classic', title: 'City Cycling Classic', category: 'Sports', venue: 'Marine Drive', city: 'Mumbai', days: 36, hour: 6, price: 349, capacity: 900, featured: false, image: '1517457373958-b7bdd4587205',
    description: 'A 40 km closed-road ride along the coast. Chip timing, mechanical support and finishers\' medals.' },
  { slug: 'founders-fireside', title: 'Founders Fireside', category: 'Networking', venue: 'Heritage Haveli', city: 'Jaipur', days: 52, hour: 18, price: 999, capacity: 120, featured: false, image: '1552664730-d307ca884978',
    description: 'A small-group evening where founders share what actually went wrong. Round-table format, off the record.' },
  // Dedicated, hidden events for demos and automated tests (never shown in public listings).
  { slug: 'demo-playground-event', title: 'Playground Demo Event', category: 'Demo', venue: 'Virtual', city: 'Online', days: 30, hour: 12, price: 100, capacity: 1_000_000, featured: false, test: true, image: null,
    description: 'Hidden event used by the in-app playground to exercise the booking pipeline.' },
  { slug: 'flash-sale-demo', title: 'Flash Sale Demo Drop', category: 'Demo', venue: 'Virtual', city: 'Online', days: 30, hour: 12, price: 499, capacity: 50, featured: false, test: true, image: null,
    description: 'Hidden event used by the live Flash Sale simulator. Its stock can be reset from the simulator page.' },
  { slug: 'load-test-event', title: 'Load Test Event', category: 'Demo', venue: 'Virtual', city: 'Online', days: 30, hour: 12, price: 100, capacity: 10, featured: false, test: true, image: null,
    description: 'Hidden event reset by automated concurrency and load tests.' },
];

export async function seed(pool, logger) {
  let inserted = 0;
  const base = Date.now();
  for (const e of EVENTS) {
    // `hour` is local time in India (UTC+05:30); store the matching UTC instant.
    const midnightUtc = new Date(base + e.days * DAY).setUTCHours(0, 0, 0, 0);
    const date = new Date(midnightUtc + (e.hour * 60 - 330) * 60_000);
    const r = await pool.query(
      `INSERT INTO events (slug, title, description, category, venue, city, event_date, image_url, ticket_price,
                           total_capacity, available_capacity, is_featured, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12)
       ON CONFLICT (slug) DO NOTHING`,
      [e.slug, e.title, e.description, e.category, e.venue, e.city, date, e.image ? IMG(e.image) : null, e.price, e.capacity, e.featured, Boolean(e.test)],
    );
    inserted += r.rowCount;
  }
  logger?.info({ inserted, total: EVENTS.length }, 'event seed applied');
  return { inserted, total: EVENTS.length };
}
