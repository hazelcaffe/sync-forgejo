import { Octokit } from "@octokit/rest";
import type { GithubOrg, GithubUser } from "./types.js";

export class GithubClient {
    private octokit: Octokit;

    constructor(token: string) {
        this.octokit = new Octokit({ auth: token });
    }

    async getUser(username: string): Promise<GithubUser | null> {
        try {
            const { data } = await this.octokit.rest.users.getByUsername({ username });

            return {
                login: data.login,
                name: data.name ?? null,
                bio: data.bio ?? null,
                avatar_url: data.avatar_url,
                email: data.email ?? null,
                websiteUrl: data.blog ?? null,
                location: data.location ?? null,
            };
        } catch (err: any) {
            if (err.status === 404) return null;
            throw err;
        }
    }

    async getOrg(org: string): Promise<GithubOrg | null> {
        try {
            const { data } = await this.octokit.rest.orgs.get({ org });

            return {
                login: data.login,
                name: data.name ?? null,
                description: data.description ?? null,
                avatar_url: data.avatar_url,
                websiteUrl: data.blog ?? null,
                location: null,
            };
        } catch (err: any) {
            if (err.status === 404) return null;
            throw err;
        }
    }
}
