import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./ui";

describe("Avatar", () => {
  it("shows the profile photo and falls back to initials when it fails", () => {
    const { container } = render(<Avatar name="Ana Souza" src="https://lh3.googleusercontent.com/a/x=s256-c" />);
    const photo = container.querySelector("img")!;
    expect(photo).toHaveAttribute("src", "https://lh3.googleusercontent.com/a/x=s256-c");
    expect(photo).toHaveAttribute("referrerpolicy", "no-referrer");
    fireEvent.error(photo);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("AS");
  });

  it("uses initials without a photo", () => {
    const { container } = render(<Avatar name="Ana Souza" src={null} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("AS");
  });
});
