const dns = require("dns");

// Render sets RENDER=true on every service, so a deployment that forgot NODE_ENV=production
// is still treated as production for security-sensitive checks.
function isProductionRuntime(env = process.env) {
    return env.NODE_ENV === "production" || env.RENDER === "true";
}

// Opt-in custom resolvers for MongoDB SRV/TXT lookups (dns.resolve*). HTTP clients use
// dns.lookup and are unaffected. Example: DNS_SERVERS=8.8.8.8,1.1.1.1
function configureDnsServers(env = process.env, resolver = dns) {
    const servers = (env.DNS_SERVERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (servers.length) resolver.setServers(servers);
    return servers;
}

module.exports = { isProductionRuntime, configureDnsServers };
