# TOM.quest

Personal website for Tom Heffernan - PhD Student in Artificial Intelligence at WPI.

## About

A minimal and elegant personal website featuring:
- Welcome page
- Bio with education and research interests
- Projects page (placeholder)
- Turing GPU dashboard
- Data labeling tools (placeholder)

## Tech Stack

- Next.js 16 with App Router
- TypeScript
- Tailwind CSS v4
- Geist font family
- Hosted on Vercel

## Development

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the site.

## Turing GPU Dashboard Setup

The Turing page requires a FastAPI backend running on the Turing HPC login node.

### On Turing

1. If you already copied a non-git `~/tom-quest-api`, move it aside: `mv ~/tom-quest-api ~/tom-quest-api.bak`
2. Clone the repo: `git clone https://github.com/Heffnt/tom.quest.git ~/tom.quest`
3. Go to the API folder: `cd ~/tom.quest/tom-quest-api`
4. Install dependencies: `uv pip install -r requirements.txt`
5. Create `.env` with `API_KEY=<your-secret-key>`
6. Run the API: `python main.py`

### Updating on Turing

- Pull the latest changes: `cd ~/tom.quest && git pull`
- Restart the API after pulling: `cd ~/tom.quest/tom-quest-api && python main.py`

### Cloudflare Tunnel (connects Vercel to Turing)

```bash
cloudflared tunnel login
cloudflared tunnel create tom-quest-api
cloudflared tunnel route dns tom-quest-api turing-api.tom.quest
cloudflared tunnel run --url http://localhost:8000 tom-quest-api
```

### Vercel Environment Variables

```
TURING_API_URL=https://turing-api.tom.quest
TURING_API_KEY=<your-secret-key>
```

## Design

- Black background (#000) with white text (#fff)
- Smooth fade-in animations
- Fixed navigation bar
- Responsive layout
- Clean typography using Geist Sans and Geist Mono
