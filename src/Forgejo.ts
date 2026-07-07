import axios, { AxiosInstance } from "axios";
import type { GithubOrg, GithubUser, OwnerType } from "./types.js";

export class ForgejoClient {
    private api: AxiosInstance;
    private baseUrl: string;
    private token: string;
    private defaultPassword: string;
    private orgOwner: string;

    constructor(baseUrl: string, token: string, defaultPassword: string, orgOwner = "") {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.token = token;
        this.defaultPassword = defaultPassword;
        this.orgOwner = orgOwner;
        this.api = axios.create({
            baseURL: `${this.baseUrl}/api/v1`,
            headers: {
                Authorization: `token ${token}`,
                "Content-Type": "application/json",
            },
        });
    }

    async ensureOwner(name: string, type: OwnerType, metadata: GithubUser | GithubOrg | null): Promise<"created" | "skipped"> {
        if (type === "organization") return this.ensureOrg(name, metadata as GithubOrg | null);
        return this.ensureUser(name, metadata as GithubUser | null);
    }

    async ensureRepo(owner: string, repo: string, type: OwnerType): Promise<"created" | "skipped"> {
        try {
            await this.api.get(`/repos/${owner}/${repo}`);
            return "skipped";
        } catch (err: any) {
            if (!this.isNotFound(err)) throw this.toError(err, `failed to check repo ${owner}/${repo}`);
        }

        const endpoint = type === "organization" ? `/orgs/${owner}/repos` : `/admin/users/${owner}/repos`;
        try {
            await this.api.post(endpoint, {
                name: repo,
                private: true,
            });
        } catch (err) {
            throw this.toError(err, `failed to create repo ${owner}/${repo}`);
        }

        return "created";
    }

    remoteUrl(owner: string, repo: string): string {
        const url = new URL(this.baseUrl);
        url.username = this.token;
        url.password = "x-oauth-basic";
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/${owner}/${repo}.git`;
        return url.toString();
    }

    redactRemote(remote: string): string {
        const url = new URL(remote);
        url.username = "<token>";
        url.password = "<redacted>";
        return url.toString();
    }

    private async ensureUser(name: string, user: GithubUser | null): Promise<"created" | "skipped"> {
        try {
            await this.api.get(`/users/${name}`);
            if (user) await this.syncUserMetadata(name, user);
            return "skipped";
        } catch (err: any) {
            if (!this.isNotFound(err)) throw this.toError(err, `failed to check user ${name}`);
        }

        try {
            await this.api.post("/admin/users", {
                email: user?.email || `${name}@localhost`,
                username: name,
                password: this.defaultPassword,
                must_change_password: false,
                full_name: user?.name || name,
                visibility: "limited",
            });
        } catch (err) {
            throw this.toError(err, `failed to create user ${name}`);
        }

        if (user) await this.syncUserMetadata(name, user);
        return "created";
    }

    private async ensureOrg(name: string, org: GithubOrg | null): Promise<"created" | "skipped"> {
        try {
            await this.api.get(`/orgs/${name}`);
            if (org) await this.syncOrgMetadata(name, org);
            return "skipped";
        } catch (err: any) {
            if (!this.isNotFound(err)) throw this.toError(err, `failed to check org ${name}`);
        }

        if (!this.orgOwner) throw new Error("FORGEJO_ORG_OWNER is required to create organizations");

        try {
            await this.api.post(`/admin/users/${this.orgOwner}/orgs`, {
                username: name,
                full_name: org?.name || name,
                description: org?.description || "",
                website: this.validUrl(org?.websiteUrl || null),
                visibility: "private",
            });
        } catch (err) {
            throw this.toError(err, `failed to create org ${name}`);
        }

        if (org) await this.syncOrgMetadata(name, org);
        return "created";
    }

    private async syncUserMetadata(name: string, user: GithubUser): Promise<void> {
        try {
            await this.api.patch(`/admin/users/${name}`, {
                email: user.email || `${name}@localhost`,
                full_name: user.name || name,
                website: this.validUrl(user.websiteUrl),
                location: user.location || "",
                description: user.bio || "",
                visibility: "limited",
            });
        } catch { }

        await this.updateAvatar(name, user.avatar_url, false);
    }

    private async syncOrgMetadata(name: string, org: GithubOrg): Promise<void> {
        try {
            await this.api.patch(`/orgs/${name}`, {
                full_name: org.name || name,
                description: org.description || "",
                website: this.validUrl(org.websiteUrl),
                location: org.location || "",
                visibility: "private",
            });
        } catch { }

        await this.updateAvatar(name, org.avatar_url, true);
    }

    private async updateAvatar(name: string, avatarUrl: string, isOrg: boolean): Promise<void> {
        if (!avatarUrl) return;

        try {
            const response = await axios.get(avatarUrl, { responseType: "arraybuffer" });
            const image = Buffer.from(response.data).toString("base64");

            if (isOrg) {
                await this.api.post(`/orgs/${name}/avatar`, { image });
                return;
            }

            await this.api.post("/user/avatar", { image }, { headers: { Sudo: name } });
        } catch { }
    }

    private validUrl(value: string | null): string {
        if (!value) return "";

        try {
            const url = new URL(value);
            return url.protocol === "http:" || url.protocol === "https:" ? value : "";
        } catch {
            return "";
        }
    }

    private isNotFound(err: any): boolean {
        return axios.isAxiosError(err) && err.response?.status === 404;
    }

    private toError(err: any, context: string): Error {
        if (!axios.isAxiosError(err)) return new Error(`${context}: ${err?.message || String(err)}`);

        const status = err.response?.status;
        const data = err.response?.data;
        const detail = typeof data === "string" ? data : data ? JSON.stringify(data) : err.message;

        return new Error(`${context}: ${status ? `HTTP ${status}: ${detail}` : err.message}`);
    }
}
