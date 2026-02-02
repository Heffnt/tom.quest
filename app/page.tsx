import Image from "next/image";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="text-center animate-fade-in">
        <Image
          src="/images/logo-white-transparent.svg"
          alt="tom.quest"
          width={400}
          height={100}
          priority
          className="mx-auto"
        />
        <p className="mt-6 text-lg md:text-xl text-white/60 animate-fade-in-delay">
          The personal website of Tom Heffernan
        </p>
      </div>
    </div>
  );
}
