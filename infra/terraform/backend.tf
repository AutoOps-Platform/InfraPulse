terraform {
  # Relative to infra/terraform; retain default local state locking.
  # Never migrate, adopt or overwrite existing state automatically.
  backend "local" {
    path = "terraform.tfstate"
  }
}
