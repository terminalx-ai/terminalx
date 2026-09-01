import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background-color,color,box-shadow,opacity] duration-100 outline-none select-none border border-transparent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-button hover:opacity-90",
        secondary: "bg-secondary text-secondary-foreground shadow-surface hover:bg-veil-strong",
        ghost: "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
        outline: "border-border bg-transparent text-foreground hover:bg-veil-raised",
        destructive: "bg-destructive/15 text-destructive hover:bg-destructive/25",
        accent: "bg-accent text-accent-foreground shadow-button hover:opacity-90",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 rounded-lg px-3 text-[13px] [&_svg]:size-4",
        sm: "h-7 rounded-md px-2.5 text-xs [&_svg]:size-3.5",
        xs: "h-6 rounded-md px-2 text-[11px] [&_svg]:size-3",
        lg: "h-9 rounded-lg px-4 text-sm [&_svg]:size-4",
        icon: "size-8 rounded-lg [&_svg]:size-4",
        "icon-sm": "size-7 rounded-md [&_svg]:size-3.5",
        "icon-xs": "size-6 rounded-md [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
