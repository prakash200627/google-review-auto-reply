const { isProductionRuntime, configureDnsServers } = require("../config/runtime");
const { duplicateLocationPipeline, summarizeDuplicates } = require("../scripts/findDuplicateLocations");

describe("runtime detection", () => {
    test.each([
        [{ NODE_ENV: "production" }, true],
        [{ RENDER: "true" }, true],
        [{ NODE_ENV: "development" }, false],
        [{ NODE_ENV: "test" }, false],
        [{}, false],
    ])("%j -> production %s", (env, expected) => {
        expect(isProductionRuntime(env)).toBe(expected);
    });
});

describe("DNS configuration", () => {
    test("uses the system resolver unless DNS_SERVERS is set", () => {
        const resolver = { setServers: jest.fn() };
        expect(configureDnsServers({}, resolver)).toEqual([]);
        expect(resolver.setServers).not.toHaveBeenCalled();
    });

    test("DNS_SERVERS opts in to custom resolvers", () => {
        const resolver = { setServers: jest.fn() };
        configureDnsServers({ DNS_SERVERS: " 8.8.8.8 , 1.1.1.1,," }, resolver);
        expect(resolver.setServers).toHaveBeenCalledWith(["8.8.8.8", "1.1.1.1"]);
    });

    test("loading the app does not override DNS servers by default", () => {
        const dns = require("dns");
        const spy = jest.spyOn(dns, "setServers");
        jest.isolateModules(() => {
            require("../index");
        });
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe("duplicate location audit (read-only)", () => {
    test("pipeline only reads: no $out, $merge or write stages", () => {
        const stages = duplicateLocationPipeline().map((s) => Object.keys(s)[0]);
        expect(stages).toEqual(["$group", "$match", "$sort"]);
    });

    test("pipeline groups on the trimmed googleLocationId and keeps groups with more than one record", () => {
        const [group, match] = duplicateLocationPipeline();
        expect(group.$group._id).toEqual({ $trim: { input: { $toString: "$googleLocationId" } } });
        expect(match).toEqual({ $match: { count: { $gt: 1 } } });
    });

    test("summary flags cross-organization duplicates and attaches review counts, oldest first", () => {
        const report = summarizeDuplicates(
            [{
                _id: "123",
                count: 2,
                orgIds: ["orgA", "orgB"],
                locations: [
                    { _id: "loc2", orgId: "orgB", name: "B", googleLocationId: "123 ", createdAt: new Date("2026-02-01") },
                    { _id: "loc1", orgId: "orgA", name: "A", googleLocationId: "123", createdAt: new Date("2026-01-01") },
                ],
            }],
            new Map([["loc1", 7]])
        );
        expect(report[0].crossOrganization).toBe(true);
        expect(report[0].locations.map((l) => [l._id, l.reviewCount])).toEqual([["loc1", 7], ["loc2", 0]]);
    });

    test("same-organization duplicates are not flagged as cross-organization", () => {
        const [group] = summarizeDuplicates([{ _id: "9", count: 2, orgIds: ["orgA"], locations: [] }]);
        expect(group.crossOrganization).toBe(false);
    });
});
