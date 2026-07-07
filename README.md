# sync-forgejo
Sync external users and Git repo's to a Forgejo instance

## Setup
```sh
git clone https://github.com/skylvie/sync-forgejo`
cd gh2fj
pnpm i
pnpm build
# Configure `.env`
```

### `.env`
See `.env.example`

## Usage
Attempt automatic run:
```sh
pnpm start
```
Manually configure:
```sh
pnpm start --setup
``` 

## What Does This Do?
It will take all users and Repo's from a path and attempt to import into a Forgejo instance. For example:
```
data/
    repos/
        user/
            a.git
```
Lets say user doesn't exist in the Forgejo server. It will create the user and all Repo's in Forgejo. Running `pnpm start` with the `--setup` flag let's you specify:
- If it's a user or organization
- Should it pull metadata (display name, PFP, bio, etc.) from GitHub
- Does the user/org already exist in Forgejo
