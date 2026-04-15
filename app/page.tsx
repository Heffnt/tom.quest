import HomeClient from "./home-client";

export default function Home() {
  return (
    <>
      {/* Hero spacer — leaves room for QuestNav's hero expansion
          (big logo + terminal + dropdown) at the top of the viewport. */}
      <div className="h-[440px]" aria-hidden />

      <div className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-start px-6 pt-8 pb-16">
        <HomeClient />
      </div>
    </>
  );
}
