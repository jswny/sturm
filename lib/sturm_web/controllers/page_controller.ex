defmodule SturmWeb.PageController do
  use SturmWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
