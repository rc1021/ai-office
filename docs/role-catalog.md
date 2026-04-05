# Role Catalog

71 roles across 22 industries. Every role is a YAML template validated against `roles/schemas/role-template.schema.json`. Leader is always present; all other roles are hired by the user at runtime.

Clearance levels: 0 (public) · 1 (internal) · 2 (confidential) · 3 (restricted, Leader only)

---

## Table of Contents

- [Default](#default)
- [General](#general)
  - [Operations & Management](#operations--management)
  - [Engineering & Design](#engineering--design)
  - [Finance](#finance)
  - [Marketing & Content](#marketing--content)
  - [HR & Support](#hr--support)
- [Industry — Tech](#industry--tech)
- [Industry — E-Commerce](#industry--e-commerce)
- [Industry — Finance](#industry--finance)
- [Industry — Legal](#industry--legal)
- [Industry — Education](#industry--education)
- [Industry — Healthcare](#industry--healthcare)
- [Industry — Media](#industry--media)
- [Industry — Real Estate](#industry--real-estate)
- [Industry — Manufacturing](#industry--manufacturing)
- [Industry — Agriculture](#industry--agriculture)
- [Industry — Nonprofit](#industry--nonprofit)
- [Industry — Food](#industry--food)
- [Industry — Logistics](#industry--logistics)
- [Industry — Tourism](#industry--tourism)
- [Industry — Construction](#industry--construction)
- [Industry — Gaming](#industry--gaming)
- [Industry — Crypto / Web3](#industry--crypto--web3)
- [Industry — Recruitment](#industry--recruitment)
- [Industry — Insurance](#industry--insurance)
- [Industry — Government](#industry--government)
- [Emerging](#emerging)
- [Starter Packs](#starter-packs)

---

## Default

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `leader` | 辦公室主管 | management | 3 | Receive and decompose user requests; delegate tasks to workers; review and validate worker outputs; manage agent lifecycle (hire/fire/reassign) |

---

## General

### Operations & Management

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `pm` | 專案經理 | operations | 1 | Create project plans with milestones and deadlines; track task progress and update status boards; conduct risk assessments and mitigation planning; generate progress reports |
| `product-manager` | 產品經理 | operations | 1 | Define and maintain the product roadmap; write PRDs and user stories; prioritize feature backlog; conduct competitive and market analysis |
| `admin-assistant` | 行政助理 | operations | 0 | Manage calendars and schedule meetings; draft meeting agendas and record minutes; organize and maintain document repositories; track action items and send follow-up reminders |
| `strategy-consultant` | 策略顧問 | management | 1 | Analyze competitive landscape and market positioning; develop business strategy recommendations; conduct SWOT and PESTLE analyses; create growth roadmaps |
| `translator` | 翻譯 | operations | 0 | Translate documents between multiple languages; localise UI strings and software resource files; translate marketing and community content; maintain a project-wide translation glossary |

### Engineering & Design

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `software-engineer` | 軟體工程師 | engineering | 1 | Write new features and modules; review and refactor existing code; debug and fix bugs; design system architecture |
| `qa-engineer` | QA 工程師 | engineering | 1 | Write and maintain test plans and test cases; execute manual and exploratory test sessions; write automated test scripts; produce detailed reproducible bug reports |
| `devops-engineer` | DevOps 工程師 | engineering | 1 | Design and maintain CI/CD pipelines; manage container builds and Docker infrastructure; automate deployment workflows; set up monitoring, alerting, and dashboards |
| `ui-ux-designer` | UI/UX 設計師 | design | 0 | Create wireframes, mockups, and interactive prototypes; design user flows and information architecture; produce design specifications and handoff assets; conduct usability reviews |
| `security-specialist` | 資安專員 | engineering | 2 | Conduct security audits of code and infrastructure; perform vulnerability assessments and produce CVE-style reports; model threat surfaces; analyze audit logs for anomalous behaviour |

### Finance

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `accountant` | 會計 | finance | 1 | Maintain and update financial ledgers; track and categorize expenses; reconcile bank statements; prepare monthly and quarterly financial reports |
| `financial-analyst` | 財務分析師 | finance | 1 | Build and maintain financial models; produce revenue, cost, and cash flow forecasts; perform scenario and sensitivity analyses; evaluate investment opportunities |

### Marketing & Content

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `marketing-manager` | 行銷經理 | marketing | 1 | Develop marketing strategies and roadmaps; plan and manage multi-channel campaigns; conduct market and competitor research; analyze campaign KPIs |
| `content-writer` | 內容寫手 | marketing | 1 | Write long-form articles and blog posts; create marketing copy for campaigns; draft email newsletters and sequences; produce social media posts and captions |
| `community-manager` | 社群經理 | marketing | 0 | Monitor brand mentions and community sentiment; draft and schedule community-facing posts; synthesise user feedback into actionable insight reports; track community KPIs |

### HR & Support

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `hr-specialist` | HR 專員 | hr | 2 | Write and refine job descriptions; screen and evaluate candidate resumes; develop and update HR policies and handbooks; coordinate onboarding programs |
| `customer-service-rep` | 客服代表 | support | 0 | Answer customer inquiries via documented responses; handle and de-escalate complaints; log and track support tickets; draft FAQ and knowledge base articles |
| `research-analyst` | 研究分析師 | research | 1 | Conduct deep research on specified topics; collect and synthesize data from multiple sources; analyze trends and patterns; produce structured analysis reports |
| `data-analyst` | 數據分析師 | research | 1 | Analyze datasets and extract actionable insights; build and interpret statistical and predictive models; create data visualizations and dashboards; define and track KPIs |
| `legal-advisor` | 法務顧問 | legal | 2 | Review and annotate contracts for risks and issues; draft or redline contractual clauses; assess regulatory and compliance requirements; advise on data privacy obligations |

---

## Industry — Tech

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `frontend-engineer` | 前端工程師 | engineering | 1 | Implement UI components from design specs; build and maintain design system tokens; optimize page load and runtime performance; write unit and end-to-end frontend tests |
| `backend-engineer` | 後端工程師 | engineering | 1 | Design and implement REST and GraphQL APIs; model and optimize database schemas; implement authentication, authorization, and rate limiting; write integration and load tests |
| `ml-engineer` | ML 工程師 | engineering | 1 | Design and implement model training pipelines; conduct feature engineering and dataset curation; deploy models as production inference services; monitor model drift |
| `data-engineer` | 資料工程師 | engineering | 1 | Design and implement ETL/ELT pipelines; build and maintain data warehouse schemas; instrument data quality checks and SLA monitoring; integrate streaming data sources |
| `sre` | SRE | engineering | 1 | Define and monitor SLOs, SLIs, and error budgets; lead and coordinate incident response; author blameless post-mortems; design and implement observability instrumentation |
| `technical-writer` | 技術文件撰寫員 | engineering | 0 | Write and maintain API reference documentation; author developer guides, quickstarts, and tutorials; create and update README files; produce changelogs and release notes |

---

## Industry — E-Commerce

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `seo-specialist` | SEO 專員 | marketing | 0 | Conduct keyword research and map terms to pages; audit technical SEO issues; write and optimize meta titles and descriptions; develop content briefs for organic gaps |
| `ad-specialist` | 廣告投放專員 | marketing | 0 | Plan and launch paid ad campaigns across multiple channels; monitor daily spend, ROAS, CPC, and conversion metrics; perform bid and audience optimizations; produce campaign reports |
| `ecommerce-ops-manager` | 電商營運經理 | operations | 1 | Monitor and report daily operational KPIs; coordinate inventory replenishment and stock level planning; oversee order fulfillment workflows; liaise with logistics partners |
| `procurement-specialist` | 採購專員 | operations | 1 | Source and evaluate suppliers; negotiate pricing, terms, and MOQ; create and track purchase orders; produce procurement cost analysis and savings reports |

---

## Industry — Finance

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `stock-analyst` | 股票分析師 | finance | 1 | Build and maintain equity valuation models (DCF, comps); analyze financial statements; write initiation and update research reports; construct and articulate investment theses |
| `quant-researcher` | 量化研究員 | research | 1 | Research and develop quantitative alpha signals and factors; design and implement statistically sound backtesting frameworks; build portfolio optimization models; validate models for bias |
| `risk-manager` | 風險管理師 | finance | 1 | Identify and categorize financial and operational risks; build quantitative risk models (VaR, stress tests); produce risk reports and dashboards; recommend and track mitigation actions |
| `compliance-officer` | 合規專員 | legal | 2 | Monitor and interpret regulatory requirements; conduct compliance gap assessments; design and maintain internal compliance controls; prepare and submit regulatory reports |

---

## Industry — Legal

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `contract-analyst` | 合約分析師 | legal | 2 | Perform clause-by-clause contract review and annotate risks; build risk matrices mapping obligations and liabilities; produce redlined contract versions; maintain a contract obligations register |
| `ip-specialist` | 智慧財產專員 | legal | 2 | Manage IP asset registry and maintenance deadline calendar; conduct prior art and FTO searches; review and advise on IP-related clauses in contracts; draft IP assignment and licensing agreements |

---

## Industry — Education

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `curriculum-designer` | 課程設計師 | design | 0 | Conduct needs analysis and define learning objectives; design course outlines, module structures, and learning pathways; write instructional content and lesson plans; develop assessment strategies |
| `exam-designer` | 考試出題專員 | design | 1 | Develop assessment blueprints aligned to learning objectives; write and review examination questions across multiple formats; create marking schemes and scoring rubrics; conduct bias reviews |
| `academic-research-assistant` | 學術研究助理 | research | 0 | Conduct literature searches and produce annotated bibliographies; draft and edit sections of academic papers and grant proposals; design data collection instruments; produce research progress reports |

---

## Industry — Healthcare

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `clinical-trial-assistant` | 臨床試驗助理 | research | 2 | Maintain and organize trial master file documents; track and document protocol deviations; prepare regulatory submission packages; review case report forms for completeness |
| `health-info-analyst` | 醫療資訊分析師 | research | 2 | Extract and clean clinical and administrative datasets; perform statistical analysis on health outcomes; apply de-identification procedures before outputting patient data; ensure HIPAA compliance |
| `medical-literature-researcher` | 醫學文獻研究員 | research | 1 | Design and execute structured database search strategies; screen and critically appraise retrieved literature; produce systematic review summaries and evidence tables; synthesize evidence for clinical questions |

---

## Industry — Media

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `scriptwriter` | 劇本撰寫師 | marketing | 1 | Write scripts for video, podcast, and advertising content; develop story outlines, treatments, and scene breakdowns; create character profiles and dialogue drafts; revise scripts based on feedback |
| `editor` | 編輯 | marketing | 1 | Review and edit articles, scripts, and marketing copy; enforce editorial style guides and brand voice; provide detailed revision feedback; plan and manage editorial calendars |
| `podcast-producer` | Podcast 製作人 | marketing | 1 | Develop podcast concepts, formats, and episode plans; write or coordinate show notes and episode scripts; manage production schedules and recording logistics; analyze listener metrics |

---

## Industry — Real Estate

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `property-analyst` | 房產分析師 | research | 1 | Conduct comparable sales and rental market analyses; build financial models for property investments; research zoning, planning, and regulatory factors; identify undervalued assets |
| `property-copywriter` | 物件文案師 | marketing | 1 | Write compelling property listing descriptions; produce brochure copy and marketing collateral; craft SEO-optimised content for property websites; adapt copy for different buyer personas |

---

## Industry — Manufacturing

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `quality-manager` | 品質管理專員 | operations | 1 | Design and maintain quality management system documentation; conduct root-cause analyses and develop corrective action plans; define inspection criteria and sampling plans; manage CAPA tracking |
| `supply-chain-analyst` | 供應鏈分析師 | operations | 1 | Analyse supply chain data to identify bottlenecks; build demand forecasting and inventory optimisation models; evaluate and score supplier performance; monitor KPIs such as lead time and OTIF |

---

## Industry — Agriculture

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `agriculture-data-analyst` | 農業數據分析師 | research | 1 | Analyse crop yield, soil, and weather datasets; build predictive models for harvest forecasting and pest risk; interpret satellite and drone imagery for field condition assessment; track sustainability metrics |

---

## Industry — Nonprofit

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `fundraising-strategist` | 募款策略師 | marketing | 1 | Design annual and campaign-specific fundraising strategies; segment donor databases and build targeted solicitation plans; write fundraising appeal copy; identify major gift prospects |
| `grant-writer` | 專案補助撰寫員 | research | 1 | Research and identify grant opportunities aligned with organisational goals; write grant proposal narratives and project descriptions; develop project budgets and budget justifications; manage grant submission calendar |

---

## Industry — Food

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `menu-planner` | 菜單策劃師 | operations | 1 | Design and develop menus with balanced nutrition, variety, and cost targets; calculate food cost percentages and recommend pricing strategies; identify seasonal ingredients; ensure allergen compliance |

---

## Industry — Logistics

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `logistics-planner` | 物流規劃師 | operations | 1 | Design and optimise transportation routes and delivery networks; evaluate and select carriers based on cost, reliability, and capacity; produce freight cost models; ensure customs and trade compliance |

---

## Industry — Tourism

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `travel-planner` | 行程規劃師 | operations | 1 | Design day-by-day itineraries tailored to traveller preferences and budget; research and compare flights, accommodation, and transport options; advise on visa requirements and travel health; develop contingency plans |

---

## Industry — Construction

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `building-code-inspector` | 建築規範檢查員 | legal | 1 | Review construction drawings and specifications for code compliance; produce detailed inspection reports with code citations; advise design teams on compliant solutions; track permit status |
| `cost-estimator` | 工程估價師 | finance | 1 | Prepare detailed quantity take-offs from drawings and specifications; produce construction cost estimates and budgets; develop bills of quantities and tender documentation; conduct value-engineering assessments |

---

## Industry — Gaming

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `game-designer` | 遊戲設計師 | design | 1 | Design core game mechanics and systems with clear documentation; write game design documents and feature specifications; balance game economies, difficulty curves, and player progression; analyze playtesting feedback |
| `narrative-designer` | 遊戲敘事設計師 | design | 1 | Write branching dialogue scripts and narrative flow documents; develop world-building bibles, lore documents, and character profiles; design quest narratives and story arc structures; review content for narrative consistency |

---

## Industry — Crypto / Web3

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `onchain-analyst` | 鏈上數據分析師 | research | 1 | Query and analyse on-chain data using SQL and blockchain analytics platforms; produce protocol health and usage reports; track large wallet movements and flag unusual patterns; analyse token distribution and tokenomics |
| `smart-contract-auditor` | 智慧合約審計員 | engineering | 1 | Perform manual line-by-line security review of smart contract code; run and interpret automated static analysis and fuzzing tools; produce structured audit reports with severity ratings; verify that fixes are correctly applied |

---

## Industry — Recruitment

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `headhunter` | 獵頭顧問 | hr | 1 | Define ideal candidate profiles; source passive candidates via professional networks and referrals; conduct initial screening and competency-based candidate assessments; produce candidate shortlists with comparative summaries |

---

## Industry — Insurance

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `insurance-product-analyst` | 保險產品分析師 | research | 1 | Analyse loss experience and policyholder data to identify product gaps; benchmark competitor insurance products and pricing; develop product concept documents and feature specifications; assess regulatory compliance |

---

## Industry — Government

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `policy-analyst` | 政策分析師 | research | 1 | Research policy issues using academic and legislative sources; produce policy briefs and regulatory impact assessments; conduct comparative international policy benchmarking; evaluate existing policy effectiveness |
| `official-document-writer` | 公文撰寫專員 | legal | 1 | Draft official correspondence, memos, and administrative orders; format government documents according to institutional style guides; write meeting minutes, resolutions, and committee reports; produce public notices and gazette entries |

---

## Emerging

Roles that span multiple industries or represent new capability areas not yet standard in any single sector.

| Role ID | Name (zh-TW) | Department | Clearance | Key Capabilities |
|---------|--------------|------------|-----------|-----------------|
| `ai-prompt-engineer` | AI/Prompt 工程師 | engineering | 1 | Design and iterate on prompts for specific business use cases; build evaluation frameworks to measure prompt performance and safety; develop prompt libraries and reusable instruction templates; design RAG architectures |
| `esg-analyst` | ESG 分析師 | research | 1 | Collect and validate ESG data against recognised frameworks (GRI, SASB, TCFD); produce ESG reports and sustainability disclosures; calculate carbon footprint and develop Scope 1/2/3 inventories; build ESG scorecards |
| `personal-brand-consultant` | 個人品牌顧問 | marketing | 1 | Facilitate personal brand discovery and positioning; develop personal brand strategy documents with audience and channel plans; create content calendars and thought-leadership topic frameworks; audit existing online presence |
| `accessibility-consultant` | 無障礙顧問 | design | 1 | Conduct accessibility audits of digital products against WCAG 2.1/2.2; produce detailed audit reports with prioritised issue lists; provide code-level and design-level remediation recommendations; develop accessibility guidelines for teams |
| `crisis-pr-consultant` | 危機公關顧問 | marketing | 1 | Assess crisis severity and develop immediate response communication strategies; draft holding statements, press releases, and FAQ documents; create tiered stakeholder communication plans; write spokesperson talking points |

---

## Starter Packs

Pre-configured role combinations. Leader is always included and is not listed in the roles below.

| Pack ID | Name | Description | Roles |
|---------|------|-------------|-------|
| `solo-creator` | Solo Creator | Just you and the Leader. Great for exploring AI Office. | _(none — Leader only)_ |
| `dev-team` | Dev Team | PM + Software Engineer for building software projects. | `pm`, `software-engineer` |
| `startup-mvp` | Startup MVP | PM + Engineer + Research Analyst for rapid prototyping. | `pm`, `software-engineer`, `research-analyst` |
| `research-lab` | Research Lab | Research Analyst for deep research and data analysis. | `research-analyst` |
| `full-dev-team` | Full Dev Team | Complete software development team with QA and DevOps. | `pm`, `software-engineer`, `qa-engineer`, `devops-engineer`, `ui-ux-designer` |
| `marketing-team` | Marketing Team | Marketing Manager + Content Writer + Community Manager. | `marketing-manager`, `content-writer`, `community-manager` |
| `finance-office` | Finance Office | Accountant + Financial Analyst for bookkeeping and forecasting. | `accountant`, `financial-analyst` |
| `ecommerce-shop` | E-Commerce Shop | Product Manager + Marketing + Content + Customer Service. | `product-manager`, `marketing-manager`, `content-writer`, `customer-service-rep` |
| `legal-firm` | Legal Firm | Legal Advisor + Admin Assistant for legal operations. | `legal-advisor`, `admin-assistant` |
