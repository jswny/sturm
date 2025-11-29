defmodule Sturm.Repo do
  use Ecto.Repo,
    otp_app: :sturm,
    adapter: Ecto.Adapters.Postgres
end
