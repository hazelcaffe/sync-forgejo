import type { Config } from "./types.js";
import dotenv from "dotenv";

dotenv.config();

export const config: Config = {
    forgejoUrl: required("FORGEJO_URL"),
    forgejoToken: required("FORGEJO_TOKEN"),
    forgejoOrgOwner: process.env.FORGEJO_ORG_OWNER || "",
    githubToken: process.env.GITHUB_TOKEN || "",
    dataPath: required("DATA_PATH"),
    defaultPassword: required("DEFAULT_PASSWORD"),
};

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}
