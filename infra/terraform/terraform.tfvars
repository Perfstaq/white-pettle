# Committed on purpose (no secrets here): see infra/terraform/.gitignore.
# Serve Perfstaq AI Visibility on os.perfstaq.com through a free Cloud Run domain mapping.
# After apply, point the DNS record at Google: CNAME os -> ghs.googlehosted.com.
domain = "os.perfstaq.com"

# The only GitHub repository allowed to deploy (see github.tf). Set by infra/move-repo.sh.
github_repo = "Perfstaq/white-pettle"

# The people who run White Petal for clients (create organisations, open any organisation; every visit is
# logged). Operator rights need a confirmed email, so listing an address no one has signed up with is safe.
platform_operators = "sathvikvk238@gmail.com"

# Razorpay LIVE plans (INR, monthly, price incl. 18% GST). Checked against Razorpay on 14 Oct 2026. Not secret.
razorpay_plan_ids = {
  STARTER_INR = "plan_TnTzscdzryYnQn" # ₹5,898.82
  GROWTH_INR  = "plan_TnU1KYMgDg3eLF" # ₹11,798.82
  AGENCY_INR  = "plan_TnU25GIC7GbME6" # ₹29,498.82
}
