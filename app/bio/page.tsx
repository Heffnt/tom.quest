export default function Bio() {
  return (
    <div className="min-h-screen px-6 py-16">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight animate-fade-in">
          Tom Heffernan
        </h1>
        <p className="mt-2 text-xl text-white/60 animate-fade-in-delay">
          PhD Student in Artificial Intelligence at WPI
        </p>

        <section className="mt-12 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-4">About</h2>
          <p className="text-white/80 leading-relaxed">
            I am a PhD student at Worcester Polytechnic Institute interested in researching 
            a broad range of AI domains. Currently, I work on backdoor attacks, causal reasoning, 
            and deterministic verification for LLMs. I am passionate about deepening my understanding 
            of the mathematical foundations of machine learning, as they provide invaluable intuitions 
            for innovation. I&apos;m excited about the future of AI, and I aim to advance the field through 
            research that not only pushes technological boundaries but also promotes social good.
          </p>
        </section>

        <section className="mt-12 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-4">Research Interests</h2>
          <ul className="list-disc list-inside text-white/80 space-y-2">
            <li>Backdoor Attacks</li>
            <li>Causal Reasoning</li>
            <li>Deterministic Verification for LLMs</li>
            <li>Mathematical Foundations of Machine Learning</li>
          </ul>
        </section>

        <section className="mt-12 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-6">Education</h2>
          <div className="space-y-8">
            <div className="border-l-2 border-white/20 pl-6">
              <h3 className="text-xl font-medium">Worcester Polytechnic Institute</h3>
              <p className="text-white/60">Doctor of Philosophy, Artificial Intelligence</p>
              <p className="text-white/40 text-sm mt-1">2024 - 2028</p>
              <p className="text-white/60 text-sm mt-2">
                Teacher&apos;s Assistant, Competitive Rock Climbing Team
              </p>
            </div>
            <div className="border-l-2 border-white/20 pl-6">
              <h3 className="text-xl font-medium">Colorado College</h3>
              <p className="text-white/60">Bachelor&apos;s degree, Computer Science</p>
              <p className="text-white/40 text-sm mt-1">2019 - 2024</p>
              <p className="text-white/60 text-sm mt-2">
                Rock climbing and club volleyball team. Capstone project on ML fraud detection.
              </p>
            </div>
          </div>
        </section>

        <section className="mt-12 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-4">Skills</h2>
          <div className="flex flex-wrap gap-2">
            {[
              "Python",
              "Machine Learning",
              "NLP",
              "Transformer Architecture",
              "Java",
              "C++",
              "Data Engineering",
              "Front-End Development",
            ].map((skill) => (
              <span
                key={skill}
                className="px-3 py-1 text-sm border border-white/20 rounded-full text-white/70"
              >
                {skill}
              </span>
            ))}
          </div>
        </section>

        <section className="mt-12 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-4">Connect</h2>
          <a
            href="https://www.linkedin.com/in/tom-heffernan-iv/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/80 hover:text-white transition-colors underline underline-offset-4"
          >
            LinkedIn
          </a>
        </section>
      </div>
    </div>
  );
}
