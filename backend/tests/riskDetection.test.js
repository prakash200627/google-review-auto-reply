const { detectHighRisk } = require("../services/riskDetection");

describe("Deterministic high-risk detection", () => {
    test.each([
        ["I got food poisoning after the chicken", "food_safety"],
        ["My son got really sick and was vomiting all night", "food_safety"],
        ["Saw a cockroach near the kitchen", "food_safety"],
        ["The chicken was undercooked chicken, pink inside", "food_safety"],
        ["I had an allergic reaction even though I told them", "allergy_medical"],
        ["They ignored my nut allergies", "allergy_medical"],
        ["My wife ended up in the emergency room", "allergy_medical"],
        ["The manager made racist comments", "harassment_discrimination"],
        ["A waiter harassed my daughter", "harassment_discrimination"],
        ["This place is a scam", "fraud_legal"],
        ["I will be contacting my lawyer", "fraud_legal"],
        ["Planning to sue them", "fraud_legal"],
        ["The owner threatened me", "threats_police"],
        ["We had to call the police", "threats_police"],
        ["Exposed wires, totally unsafe for kids", "unsafe_conditions"],
        ["Reporting this to the health department", "unsafe_conditions"],
    ])("flags %p as %s", (text, category) => {
        const result = detectHighRisk(text);
        expect(result.isHighRisk).toBe(true);
        expect(result.categories).toContain(category);
    });

    test.each([
        "The food was cold and service was very slow.",
        "Terrible service, food was cold.",
        "Sick vibes and great music!",
        "I'm sick of waiting 40 minutes for a table",
        "The waiter was ill-mannered",
        "Amazing biryani, friendly staff, will come again",
        "Overpriced for the portion size",
        "Our server Tom was a legend",
        "",
    ])("does not flag ordinary review %p", (text) => {
        expect(detectHighRisk(text)).toEqual({ isHighRisk: false, categories: [] });
    });

    test("handles non-string input without throwing", () => {
        expect(detectHighRisk(undefined).isHighRisk).toBe(false);
        expect(detectHighRisk(null).isHighRisk).toBe(false);
        expect(detectHighRisk(42).isHighRisk).toBe(false);
    });

    test("reports multiple categories", () => {
        const result = detectHighRisk("Got food poisoning and the manager threatened to call the police on us");
        expect(result.categories).toEqual(expect.arrayContaining(["food_safety", "threats_police"]));
    });
});
