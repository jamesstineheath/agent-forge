import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

export async function GET() {
  try {
    const historyPath = path.join(
      process.cwd(),
      "docs",
      "feedback-compiler-history.json"
    );
    const content = fs.readFileSync(historyPath, "utf-8");
    return NextResponse.json(JSON.parse(content));
  } catch {
    return NextResponse.json({ changes: [], last_run: "" });
  }
}
