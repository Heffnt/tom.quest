import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { userId } = await request.json();
  const isTom = userId === process.env.TOM_USER_ID;
  return NextResponse.json({ isTom });
}
