import type { TargetingProfile } from "@/lib/types";

/**
 * The AJACE five-dimension Targeting Profile — the single source of truth for both
 * query-mode sources (phrases become API search queries, e.g. SAM.gov) and score-mode
 * sources (phrases become weighted matchers over crawled items).
 *
 * Every list ships verbatim from the targeting requirements (docs/TARGETING-ENGINE-PLAN.md §3).
 * Points marked "configurable default" fill gaps the requirement's §9 table left open.
 * Everything here is editable in Admin → Targeting; this constant is only the seed.
 */
export const DEFAULT_TARGETING_PROFILE: TargetingProfile = {
  version: 1,

  // ── Dimension 2a: capability phrase groups (§1 Primary Search Phrases) ──────
  capabilities: [
    {
      key: "program_management",
      label: "Program Management",
      points: 9, // §9
      phrases: [
        "Program Management", "Project Management", "PMO Support", "Program Office Support",
        "Project Management Office", "Technical Program Management", "IT Program Management",
        "Program Support Services", "Management Support Services", "Enterprise Program Management",
      ],
    },
    {
      key: "acquisition_support",
      label: "Acquisition Support",
      points: 7, // §9
      phrases: [
        "Acquisition Support", "Contract Support", "Procurement Support", "Contract Administration",
        "Acquisition Management", "Federal Acquisition Support", "Procurement Operations",
        "Source Selection Support", "Contract Closeout", "Acquisition Lifecycle",
      ],
    },
    {
      key: "it_modernization",
      label: "IT Modernization",
      points: 10, // §9
      phrases: [
        "Digital Transformation", "Business Process Modernization", "IT Modernization",
        "Legacy System Modernization", "Modernization Services", "Enterprise Modernization",
      ],
    },
    {
      key: "application_development",
      label: "Application Development",
      points: 10, // §9
      phrases: [
        "Application Development", "Software Development", "Agile Development",
        "Full Stack Development", "DevSecOps", "Systems Integration", "API Integration",
        "Custom Software Development", "Enterprise Application Support", "Low Code",
        "Microsoft Power Platform", "PowerApps", "Power Automate",
      ],
    },
    {
      key: "data_analytics",
      label: "Data Analytics",
      points: 9, // §9
      phrases: [
        "Data Analytics", "Data Management", "Business Intelligence", "Dashboard Development",
        "Data Warehouse", "Data Governance", "Data Integration", "ETL", "SQL",
        "Reporting Services", "Power BI", "Tableau",
      ],
    },
    {
      key: "ai",
      label: "AI",
      points: 9, // §9
      phrases: [
        "Artificial Intelligence", "AI", "Machine Learning", "Generative AI",
        "Intelligent Automation", "Robotic Process Automation", "RPA", "AI Enablement",
        "AI Integration", "AI Services",
      ],
    },
    {
      key: "cloud",
      label: "Cloud",
      points: 8, // §9
      phrases: [
        "Cloud Migration", "Cloud Engineering", "Azure", "AWS", "Cloud Modernization",
        "Cloud Operations", "Cloud Support", "Hybrid Cloud",
      ],
    },
    {
      key: "cybersecurity",
      label: "Cybersecurity",
      points: 8, // §9
      phrases: [
        "Cybersecurity", "Information Security", "Security Operations", "SOC",
        "Vulnerability Management", "Zero Trust", "Risk Management Framework",
        "Continuous Monitoring", "Security Assessment",
      ],
    },
    {
      key: "infrastructure",
      label: "Infrastructure",
      points: 6, // configurable default (not in §9 table)
      phrases: [
        "Infrastructure Support", "Enterprise IT", "Systems Administration", "Network Support",
        "IT Operations", "Enterprise Operations",
      ],
    },
    {
      key: "service_desk",
      label: "Service Desk",
      points: 7, // §9
      phrases: [
        "Service Desk", "Help Desk", "IT Support", "End User Support", "Customer Support",
        "Tier 1", "Tier 2", "Tier 3",
      ],
    },
    {
      key: "business_analysis",
      label: "Business Analysis",
      points: 7, // §9
      phrases: ["Business Analysis"],
    },
  ],

  // ── Dimension 2b: labor categories (§3) → parent capability group ───────────
  laborCategories: [
    { title: "Program Manager", group: "program_management" },
    { title: "Project Manager", group: "program_management" },
    { title: "Business Analyst", group: "business_analysis" },
    { title: "Functional Analyst", group: "business_analysis" },
    { title: "Technical Writer", group: "program_management" },
    { title: "Solutions Architect", group: "application_development" },
    { title: "Enterprise Architect", group: "application_development" },
    { title: "Database Administrator", group: "data_analytics" },
    { title: "Data Analyst", group: "data_analytics" },
    { title: "Data Engineer", group: "data_analytics" },
    { title: "Software Engineer", group: "application_development" },
    { title: "Software Developer", group: "application_development" },
    { title: "Full Stack Developer", group: "application_development" },
    { title: "Cloud Engineer", group: "cloud" },
    { title: "DevSecOps Engineer", group: "application_development" },
    { title: "Cybersecurity Analyst", group: "cybersecurity" },
    { title: "Help Desk Specialist", group: "service_desk" },
    { title: "Systems Administrator", group: "infrastructure" },
    { title: "Network Engineer", group: "infrastructure" },
    { title: "QA Analyst", group: "application_development" },
    { title: "Test Engineer", group: "application_development" },
  ],

  // ── Dimension 2c: technologies (§4) → parent capability group ───────────────
  technologies: [
    // Microsoft
    { term: ".NET", group: "application_development" },
    { term: "C#", group: "application_development" },
    { term: "SQL Server", group: "data_analytics" },
    { term: "SharePoint", group: "application_development" },
    { term: "Microsoft Azure", group: "cloud" },
    { term: "Power BI", group: "data_analytics" },
    { term: "Power Platform", group: "application_development" },
    { term: "Dynamics 365", group: "application_development" },
    // Cloud
    { term: "AWS", group: "cloud" },
    { term: "Azure", group: "cloud" },
    { term: "Kubernetes", group: "cloud" },
    { term: "Docker", group: "cloud" },
    { term: "Terraform", group: "cloud" },
    // Development
    { term: "Java", group: "application_development" },
    { term: "Python", group: "application_development" },
    { term: "JavaScript", group: "application_development" },
    { term: "React", group: "application_development" },
    { term: "Angular", group: "application_development" },
    { term: "Node.js", group: "application_development" },
    { term: "REST API", group: "application_development" },
    // Database
    { term: "Oracle", group: "data_analytics" },
    { term: "PostgreSQL", group: "data_analytics" },
    { term: "MySQL", group: "data_analytics" },
  ],

  // ── Dimension 1b: government functional areas (§2) ──────────────────────────
  functionalAreas: {
    points: 4, // configurable default (supporting signal, not in §9 table)
    phrases: [
      "Administrative Support", "Program Support", "Business Operations", "Technical Assistance",
      "Technical Support", "Operational Support", "Enterprise Support", "Mission Support",
      "Management Consulting", "Organizational Change Management",
    ],
  },

  // ── Dimension 3: contract vehicles (§5) ─────────────────────────────────────
  vehicles: {
    gsaMasPoints: 6, // §9 "GSA MAS = 6"
    otherPoints: 4, // configurable default
    gsaTerms: ["GSA MAS", "Multiple Award Schedule"],
    otherTerms: ["BPA", "Blanket Purchase Agreement", "Task Order"],
  },
  solicitationTypes: [
    { term: "RFP", points: 2 },
    { term: "RFQ", points: 2 },
    { term: "RFI", points: 1 },
    { term: "Sources Sought", points: 1 },
    { term: "ITB", points: 2 },
    { term: "IFB", points: 2 },
  ],

  // ── Dimension 4: socioeconomic set-asides (§6) — AJACE is 8(a), WOSB, MBE ──
  setAsides: [
    { label: "8(a) Set-Aside", points: 10, terms: ["8(a)", "8a set aside", "8(a) set-aside", "8(a) sole source"] }, // §9
    { label: "Sole Source / Direct Award", points: 10, terms: ["Sole Source", "Direct Award"] }, // highest tier; configurable default
    { label: "WOSB Set-Aside", points: 10, terms: ["Woman-Owned Small Business", "Women-Owned Small Business", "WOSB", "EDWOSB"] }, // §9
    { label: "Small Business Set-Aside", points: 8, terms: ["Small Business Set Aside", "Small Business Set-Aside", "Total Small Business"] }, // §9
    { label: "HUBZone", points: 6, terms: ["HUBZone"] }, // secondary; configurable default
    { label: "SDVOSB", points: 6, terms: ["SDVOSB", "Service-Disabled Veteran-Owned"] }, // secondary
    { label: "MBE", points: 6, terms: ["MBE", "Minority Business Enterprise"] }, // secondary
    { label: "Small Business (general)", points: 2, terms: ["Small Business", "Socioeconomic Set Aside", "Socioeconomic Set-Aside"] }, // general
  ],

  // ── Metadata: priority agencies (§7) ────────────────────────────────────────
  agencies: {
    federalPoints: 6, // §9 "Federal Agency = 6"
    statePoints: 5, // §9 "State Government = 5"
    federal: [
      { name: "GSA", aliases: ["General Services Administration"] },
      { name: "Department of Transportation", aliases: ["DOT"] },
      { name: "FAA", aliases: ["Federal Aviation Administration"] },
      { name: "FMCSA", aliases: ["Federal Motor Carrier Safety Administration"] },
      { name: "HUD", aliases: ["Housing and Urban Development"] },
      { name: "HHS", aliases: ["Health and Human Services"] },
      { name: "CMS", aliases: ["Centers for Medicare & Medicaid Services", "Centers for Medicare and Medicaid Services"] },
      { name: "NIH", aliases: ["National Institutes of Health"] },
      { name: "CDC", aliases: ["Centers for Disease Control"] },
      { name: "DHS", aliases: ["Department of Homeland Security", "Homeland Security"] },
      { name: "CBP", aliases: ["Customs and Border Protection"] },
      { name: "USCIS", aliases: ["Citizenship and Immigration Services"] },
      { name: "DOJ", aliases: ["Department of Justice"] },
      { name: "Treasury", aliases: ["Department of the Treasury"] },
      { name: "IRS", aliases: ["Internal Revenue Service"] },
      { name: "USDA", aliases: ["Department of Agriculture"] },
      { name: "VA", aliases: ["Veterans Affairs", "Department of Veterans Affairs"] },
      { name: "DoD", aliases: ["Department of Defense", "Defense Department"], itOnly: true }, // §7 "DoD (IT only)"
      { name: "DOE", aliases: ["Department of Energy"] },
      { name: "NHTSA", aliases: ["National Highway Traffic Safety Administration"] },
      { name: "FDIC", aliases: ["Federal Deposit Insurance Corporation"] },
    ],
    states: [
      "Virginia", "Maryland", "Pennsylvania", "New York", "New Jersey", "North Carolina",
      "South Carolina", "Georgia", "Florida", "Texas", "Ohio", "Minnesota", "Mississippi",
    ],
  },

  // ── Dimension 5: exclude keywords (§8) ──────────────────────────────────────
  exclusions: [
    { group: "Construction", terms: ["Construction", "Roofing", "HVAC", "Plumbing", "Electrical", "Janitorial", "Landscaping", "Snow Removal", "Concrete", "Paving"] },
    { group: "Medical", terms: ["Pharmaceuticals", "Medical Equipment", "Nursing", "Physician", "Hospital Equipment"] },
    { group: "Vehicles", terms: ["Vehicle Purchase", "Fleet Vehicles", "Buses", "Heavy Equipment"] },
    { group: "Supplies", terms: ["Office Supplies", "Furniture", "Uniforms", "Food Service", "Fuel"] },
    { group: "Architecture", terms: ["Architectural Design", "Civil Engineering", "Surveying"] },
  ],

  // ── Recommendation: NAICS alignment ─────────────────────────────────────────
  naics: { codes: ["541511", "541512", "541513", "541519", "518210"], points: 6 },

  // ── Recommendation: estimated contract value (best-effort; sweet-spot curve) ─
  valueBands: [
    { maxUsd: 25_000, points: -2, label: "< $25k" },
    { maxUsd: 100_000, points: 0, label: "$25k–$100k" },
    { maxUsd: 1_000_000, points: 2, label: "$100k–$1M" },
    { maxUsd: 10_000_000, points: 3, label: "$1M–$10M" },
    { maxUsd: null, points: 1, label: "> $10M" },
  ],

  // ── §9 thresholds & §10 date bands (verbatim) ───────────────────────────────
  thresholds: { pursue: 80, captureReview: 60, manualReview: 40 },
  dateBands: { minDays: 10, urgentMax: 20, standardMax: 45 },
};
