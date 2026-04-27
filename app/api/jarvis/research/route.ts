import { NextRequest, NextResponse } from "next/server";
import { requireTom } from "@/app/api/jarvis/_utils";

type Paper = {
  id: string;
  title: string;
  summary: string;
  published: string;
  authors: string[];
  url: string;
};

function stripXml(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extractEntries(xml: string): Paper[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map((match) => {
    const chunk = match[1];
    const id = stripXml(chunk.match(/<id>([\s\S]*?)<\/id>/)?.[1] || "");
    const title = stripXml(chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "Untitled");
    const summary = stripXml(chunk.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "");
    const published = stripXml(chunk.match(/<published>([\s\S]*?)<\/published>/)?.[1] || "");
    const authors = [...chunk.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => stripXml(m[1]));
    return { id, title, summary, published, authors, url: id };
  }).filter((paper) => paper.id && paper.title);
}

export async function GET(request: NextRequest) {
  if (!(await requireTom(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const seed = Math.floor(Math.random() * 40);
  const query = encodeURIComponent('(ti:"large language model" OR abs:"large language model" OR all:llm OR all:instruction-tuning) AND cat:cs.CL');
  const url = `https://export.arxiv.org/api/query?search_query=${query}&start=${seed}&max_results=12&sortBy=submittedDate&sortOrder=descending`;
  try {
    const response = await fetch(url, { cache: "no-store" });
    const xml = await response.text();
    const papers = extractEntries(xml);
    const chosen = papers[Math.floor(Math.random() * papers.length)] || null;
    return NextResponse.json({ paper: chosen, count: papers.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to fetch arXiv" }, { status: 500 });
  }
}
