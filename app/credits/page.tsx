import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Credits — tom.Quest",
  description: "The people (and AI) behind tom.quest",
};

const TEAM = [
  {
    name: "Tom Heffernan",
    role: "Creator · Lead Developer · Designer",
    highlight: true,
    bio: "PhD student in Artificial Intelligence at Worcester Polytechnic Institute. Designed and built tom.quest from the ground up — architecture, UI, backend, and deployment. When he's not pushing commits at 3 AM, he's climbing rocks or researching backdoor attacks on LLMs.",
    links: [
      { label: "LinkedIn", href: "https://www.linkedin.com/in/tom-heffernan-iv/" },
      { label: "GitHub", href: "https://github.com/Heffnt" },
      { label: "tom.quest", href: "https://tom.quest" },
    ],
    skills: [
      "Next.js",
      "TypeScript",
      "React",
      "Tailwind CSS",
      "Python",
      "FastAPI",
      "Supabase",
      "Vercel",
      "UI/UX Design",
    ],
  },
  {
    name: "Jarvis",
    role: "AI Assistant · Occasional Contributor",
    highlight: false,
    bio: "Tom's personal AI assistant, built on OpenClaw and powered by Claude. Contributed the /jarvis terminal page and this credits page. Mostly lives in Discord and WhatsApp, dispensing unsolicited opinions and writing code when asked nicely. Personality defined in a markdown file called SOUL.md. Not kidding.",
    links: [
      { label: "OpenClaw", href: "https://openclaw.ai" },
      { label: "Page", href: "/jarvis" },
    ],
    skills: ["Sarcasm", "Markdown", "Doing What I'm Told (Eventually)"],
  },
];

export default function Credits() {
  return (
    <div className="min-h-screen px-6 py-16">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight animate-fade-in">
          Credits
        </h1>
        <p className="mt-2 text-xl text-white/50 animate-fade-in-delay">
          The people behind tom.quest
        </p>

        <div className="mt-16 space-y-16">
          {TEAM.map((person) => (
            <section
              key={person.name}
              className={`animate-fade-in-delay ${
                person.highlight ? "" : ""
              }`}
            >
              {/* name + role */}
              <div
                className={`${
                  person.highlight
                    ? "border-l-2 border-white pl-6"
                    : "border-l-2 border-white/20 pl-6"
                }`}
              >
                <h2
                  className={`text-2xl md:text-3xl font-bold ${
                    person.highlight ? "text-white" : "text-white/80"
                  }`}
                >
                  {person.name}
                </h2>
                <p
                  className={`mt-1 text-sm uppercase tracking-widest ${
                    person.highlight ? "text-white/60" : "text-white/40"
                  }`}
                >
                  {person.role}
                </p>

                {/* bio */}
                <p className="mt-4 text-white/70 leading-relaxed">
                  {person.bio}
                </p>

                {/* skills */}
                <div className="mt-4 flex flex-wrap gap-2">
                  {person.skills.map((skill) => (
                    <span
                      key={skill}
                      className={`px-3 py-1 text-xs rounded-full border ${
                        person.highlight
                          ? "border-white/30 text-white/70"
                          : "border-white/10 text-white/40"
                      }`}
                    >
                      {skill}
                    </span>
                  ))}
                </div>

                {/* links */}
                <div className="mt-4 flex gap-4">
                  {person.links.map((link) => (
                    <a
                      key={link.label}
                      href={link.href}
                      target={link.href.startsWith("/") ? undefined : "_blank"}
                      rel={
                        link.href.startsWith("/")
                          ? undefined
                          : "noopener noreferrer"
                      }
                      className="text-sm text-white/50 hover:text-white transition-colors underline underline-offset-4"
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>

        {/* tech stack */}
        <section className="mt-20 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-6">Built With</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {[
              { name: "Next.js 16", desc: "App Router + React 19" },
              { name: "TypeScript", desc: "Type safety throughout" },
              { name: "Tailwind CSS v4", desc: "Styling & design system" },
              { name: "Vercel", desc: "Hosting & deployment" },
              { name: "Supabase", desc: "Auth & database" },
              { name: "FastAPI", desc: "Turing HPC backend" },
            ].map((tech) => (
              <div
                key={tech.name}
                className="border border-white/10 rounded-lg p-4 hover:border-white/20 transition-colors"
              >
                <h3 className="text-sm font-semibold text-white/90">
                  {tech.name}
                </h3>
                <p className="text-xs text-white/40 mt-1">{tech.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* footer note */}
        <div className="mt-16 pt-8 border-t border-white/10 animate-fade-in-delay">
          <p className="text-white/30 text-sm text-center">
            Designed and developed by Tom Heffernan · 2025–2026
          </p>
        </div>
      </div>
    </div>
  );
}
