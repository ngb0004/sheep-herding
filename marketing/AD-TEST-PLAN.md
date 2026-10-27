# Flock Rescue: ad concept test

Goal: find out which version of the game people want, and who wants it, before building more.
We run three short video ads, each pitching a different angle, all pointing at the same landing page,
and compare how cheaply each one gets people to click and play.

## The three ads

| File | Angle | What it tests |
|---|---|---|
| `ad-stampede.mp4` | 6 sheep snowball through multiplier gates into a flock of hundreds and pour into the pen | Does spectacle sell? |
| `ad-so-close.mp4` | The flock pours in, one sheep is left outside as night falls: "Only 2% bring every sheep home. Can you?" | Does challenge / "I could do better" sell? |
| `ad-cozy-farm.mp4` | A little island farm gets built piece by piece; the collie gets a flat cap | Does the cozy farm-building audience bite? |

All are 1080×1920 (9:16), silent, 20–40 s. Add music in Ads Manager (Meta has a free sound library); ads with sound do better.

The farm-building feature isn't in the demo yet. Its ad and the landing page say "coming soon", which keeps it honest.
If the cozy ad wins, we build that next.

## Landing page

`https://ngb0004.github.io/sheep-herding/`: trailer, "Play free in your browser" button, "coming soon" store badges.
The demo is at `/play/`.

Before running ads, open `index.html` and fill in `CONFIG` at the bottom:

- `metaPixelId`: from Meta Events Manager → Connect data → Web → Meta Pixel. This lets Ads Manager count
  page views and demo plays (`PlayDemo`) per ad.
- `signupEndpoint` (optional): a form endpoint such as Formspree (free tier is fine). Until it's set, the
  email box stays hidden, so we never pretend to collect emails we can't store.

## Setting it up in Meta Ads Manager

1. **Business account**: business.facebook.com → create a Business portfolio, an ad account and a Facebook Page for "Flock Rescue".
2. **Campaign**: objective **Traffic** (or **Engagement**). Destination: website, landing page URL.
   Turn **Advantage campaign budget off** so each ad gets an equal share.
3. **One ad set per ad** (three ad sets), identical except the video:
   - Budget: **$20–40/day each**, run **3–5 days** (about $100 per ad).
   - Location: United States (add UK/Ireland/Canada/Australia if you want English-speaking breadth).
   - Age 18–65+, all genders. **Don't narrow the audience**: we want Meta to show us who responds.
   - Placements: Advantage+ (lets it use Reels, Stories, Feed).
4. **Ad**: upload the video, add a music track, use the copy below, CTA button **Play Game** (or **Learn More**).
5. Add `?utm_source=meta&utm_campaign=concept&utm_content=stampede` (or `so-close` / `cozy-farm`) to each ad's URL
   so visits can be told apart. The landing page passes these through to the game link.

### Ad copy

**Stampede**
- Primary text: "Start with 6 sheep. End with 700. 🐑🐑🐑 How big a flock can you bring home?"
- Headline: "Play free in your browser"

**So close**
- Primary text: "1 sheep left and the sun's going down… 😱 Only 2% bring every sheep home. Can you?"
- Headline: "Think you can do better?"

**Cozy farm**
- Primary text: "Herd your sheep home, then build the coziest little farm in Ireland 🏡🐕 Coming soon. Try the demo free."
- Headline: "Your dream farm awaits"

## What to read after 3–5 days

In Ads Manager, add these columns and compare the three ads:

| Metric | What it tells you | Rough "good" for games |
|---|---|---|
| **Hook rate**: 3-second video plays ÷ impressions | Does the first second stop the scroll? | 25%+ |
| **CTR (link click-through rate)** | Does the ad make people want it? | 1%+ is decent, 2%+ is strong |
| **Cost per landing-page view** | What a visitor costs | lower is better; compare the three |
| **PlayDemo events** (needs the Pixel) | Did they actually try it? | the real signal |
| **Breakdown → Age and Gender** | Who responds to each angle | answers "women 30–55 or someone else?" |

How to decide:
- One ad clearly cheaper and with better CTR → that's the angle the game should lean into.
- Look at the age/gender breakdown of the winner: that's your audience.
- If all three are weak (CTR under 0.7%), the hook needs work before the game does; we try new first seconds.

Small budgets give rough answers: they'll pick out a clear winner, but won't separate two close ones.
