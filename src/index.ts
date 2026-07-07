import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import ora from "ora";
import { config } from "./config.js";
import { ForgejoClient } from "./Forgejo.js";
import { GithubClient } from "./Github.js";
import type { GithubOrg, GithubUser, LocalRepo, OwnerSetup, OwnerType } from "./types.js";

interface LocalOwner {
    name: string;
    repos: LocalRepo[];
}

interface Summary {
    ownersCreated: number;
    ownersSkipped: number;
    reposCreated: number;
    reposSkipped: number;
    reposPushed: number;
    errors: number;
}

const setupMode = process.argv.includes("--setup");
const setupPath = path.resolve("sync-forgejo.setup.json");
const forgejo = new ForgejoClient(
    config.forgejoUrl,
    config.forgejoToken,
    config.defaultPassword,
    config.forgejoOrgOwner,
);
const github = config.githubToken ? new GithubClient(config.githubToken) : null;

async function main(): Promise<void> {
    const spinner = ora("Scanning data path").start();
    const summary: Summary = {
        ownersCreated: 0,
        ownersSkipped: 0,
        reposCreated: 0,
        reposSkipped: 0,
        reposPushed: 0,
        errors: 0,
    };

    try {
        const owners = await readLocalOwners(config.dataPath);
        spinner.succeed(chalk.green(`Found ${owners.length} owner folders`));

        if (owners.length === 0) {
            console.log(chalk.yellow("No user or organization folders found."));
            return;
        }

        const setups = setupMode ? await promptSetup(owners) : await loadSetup(owners);

        for (const owner of owners) {
            await processOwner(owner, setups.get(owner.name)!, summary);
        }

        console.log(chalk.bold.green("Sync completed"));
        console.log(`Owners: ${chalk.green(summary.ownersCreated)} created, ${chalk.yellow(summary.ownersSkipped)} skipped`);
        console.log(`Repos: ${chalk.green(summary.reposCreated)} created, ${chalk.yellow(summary.reposSkipped)} skipped, ${chalk.blue(summary.reposPushed)} pushed`);
        if (summary.errors > 0) console.log(chalk.red(`Errors: ${summary.errors}`));
    } catch (err: any) {
        spinner.fail(chalk.red(err?.message || String(err)));
        process.exitCode = 1;
    }
}

async function readLocalOwners(dataPath: string): Promise<LocalOwner[]> {
    const entries = await readdir(dataPath, { withFileTypes: true });
    const owners: LocalOwner[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const ownerPath = path.join(dataPath, entry.name);
        const repoEntries = await readdir(ownerPath, { withFileTypes: true });
        const repos = repoEntries
            .filter((repoEntry) => repoEntry.isDirectory() && repoEntry.name.endsWith(".git"))
            .map((repoEntry) => ({
                name: repoEntry.name.slice(0, -4),
                path: path.join(ownerPath, repoEntry.name),
            }));

        owners.push({ name: entry.name, repos });
    }

    return owners.sort((a, b) => a.name.localeCompare(b.name));
}

async function promptSetup(owners: LocalOwner[]): Promise<Map<string, OwnerSetup>> {
    const rl = readline.createInterface({ input, output });
    const setups = new Map<string, OwnerSetup>();

    try {
        for (const owner of owners) {
            console.log(chalk.bold(`\n${owner.name}`));
            const type = await promptOwnerType(rl);
            const alreadyExists = await promptYesNo(rl, "Already exists in Forgejo? (y/n) ");
            const githubIntegration = await promptYesNo(rl, "GitHub integration? (y/n) ");
            setups.set(owner.name, { type, alreadyExists, githubIntegration });
        }
    } finally {
        rl.close();
    }

    await saveSetup(setups);
    console.log(chalk.green(`Saved setup to ${setupPath}`));

    return setups;
}

async function promptOwnerType(rl: readline.Interface): Promise<OwnerType> {
    while (true) {
        const answer = (await rl.question("User or organization? ")).trim().toLowerCase();
        if (answer === "user" || answer === "u") return "user";
        if (answer === "organization" || answer === "org" || answer === "o") return "organization";
        console.log(chalk.yellow("Please enter user or organization."));
    }
}

async function promptYesNo(rl: readline.Interface, question: string): Promise<boolean> {
    while (true) {
        const answer = (await rl.question(question)).trim().toLowerCase();
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
        console.log(chalk.yellow("Please enter y or n."));
    }
}

async function loadSetup(owners: LocalOwner[]): Promise<Map<string, OwnerSetup>> {
    try {
        const raw = await readFile(setupPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, Partial<OwnerSetup>>;
        const setups = new Map<string, OwnerSetup>();

        for (const owner of owners) {
            const setup = parsed[owner.name];
            if (!setup) {
                setups.set(owner.name, { type: "user", alreadyExists: false, githubIntegration: false });
                continue;
            }

            setups.set(owner.name, {
                type: setup.type === "organization" ? "organization" : "user",
                alreadyExists: setup.alreadyExists === true,
                githubIntegration: setup.githubIntegration === true,
            });
        }

        return setups;
    } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;

        console.log(chalk.yellow(`No ${path.basename(setupPath)} found; defaulting all folders to new users without GitHub integration.`));
        return defaultSetup(owners);
    }
}

async function saveSetup(setups: Map<string, OwnerSetup>): Promise<void> {
    const output = Object.fromEntries([...setups.entries()].sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(setupPath, `${JSON.stringify(output, null, 4)}\n`);
}

function defaultSetup(owners: LocalOwner[]): Map<string, OwnerSetup> {
    return new Map(owners.map((owner) => [owner.name, { type: "user", alreadyExists: false, githubIntegration: false }]));
}

async function processOwner(owner: LocalOwner, setup: OwnerSetup, summary: Summary): Promise<void> {
    const spinner = ora(`Processing ${setup.type} ${owner.name}`).start();

    try {
        const metadata = setup.githubIntegration ? await getGithubMetadata(owner.name, setup.type) : null;
        const ownerStatus = await forgejo.ensureOwner(owner.name, setup.type, metadata, setup.alreadyExists);

        if (ownerStatus === "created") {
            summary.ownersCreated++;
            spinner.succeed(chalk.green(`Created ${setup.type} ${owner.name}`));
        } else {
            summary.ownersSkipped++;
            spinner.info(chalk.yellow(`Skipped existing ${setup.type} ${owner.name}`));
        }

        for (const repo of owner.repos) {
            await processRepo(owner.name, repo, setup.type, summary);
        }
    } catch (err: any) {
        summary.errors++;
        spinner.fail(chalk.red(`Failed ${owner.name}: ${err?.message || String(err)}`));
    }
}

async function getGithubMetadata(name: string, type: OwnerType): Promise<GithubUser | GithubOrg | null> {
    if (!github) throw new Error("GITHUB_TOKEN is required when GitHub integration is enabled");

    const metadata = type === "organization" ? await github.getOrg(name) : await github.getUser(name);
    if (!metadata) console.log(chalk.yellow(`GitHub ${type} ${name} was not found; continuing without metadata`));

    return metadata;
}

async function processRepo(owner: string, repo: LocalRepo, type: OwnerType, summary: Summary): Promise<void> {
    const spinner = ora(`Processing repo ${owner}/${repo.name}`).start();

    try {
        const repoStatus = await forgejo.ensureRepo(owner, repo.name, type);

        if (repoStatus === "skipped") {
            summary.reposSkipped++;
            spinner.info(chalk.yellow(`Skipped existing repo ${owner}/${repo.name}`));
            return;
        }

        summary.reposCreated++;
        spinner.text = `Pushing ${owner}/${repo.name}`;
        await pushMirror(repo.path, forgejo.remoteUrl(owner, repo.name));
        summary.reposPushed++;
        spinner.succeed(chalk.green(`Created and pushed repo ${owner}/${repo.name}`));
    } catch (err: any) {
        summary.errors++;
        spinner.fail(chalk.red(`Failed repo ${owner}/${repo.name}: ${err?.message || String(err)}`));
    }
}

function pushMirror(gitDir: string, remote: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("git", ["--git-dir", gitDir, "push", "--mirror", remote], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(stderr.trim() || `git push failed with exit code ${code}`));
        });
    });
}

main();
