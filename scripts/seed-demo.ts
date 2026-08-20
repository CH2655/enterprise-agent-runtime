import { seedDemoData } from "./demo-data.js";

const apiBaseUrl = process.env.DEMO_API_BASE_URL ?? "http://127.0.0.1:3001/api";
const summary = await seedDemoData(apiBaseUrl);

console.log("Demo data ready");
console.log(`  created: ${summary.created.length}`);
console.log(`  reused: ${summary.skipped.length}`);
console.log(`  approved: ${summary.approved.length}`);
