import { cn } from "@/lib/utils";

export const BentoGrid = ({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) => {
  return (
    <div
      className={cn(
        "mx-auto grid max-w-7xl grid-cols-1 gap-4 md:auto-rows-[18rem] md:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
};

export const BentoGridItem = ({
  as: Component = "div",
  className,
  children,
  title,
  description,
  header,
  icon,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  as?: "div" | "section" | "article";
  className?: string;
  children?: React.ReactNode;
  title?: string | React.ReactNode;
  description?: string | React.ReactNode;
  header?: React.ReactNode;
  icon?: React.ReactNode;
}) => {
  return (
    <Component
      {...props}
      className={cn(
        "group/bento relative row-span-1 flex min-w-0 flex-col rounded-xl border border-border bg-surface transition-shadow duration-200 motion-reduce:transition-none",
        children ? "overflow-hidden" : "justify-between space-y-4 p-4 hover:shadow-xl",
        className,
      )}
    >
      {children ?? <>{header}
      <div>
        {icon}
        <div className="mt-2 mb-2 font-sans font-bold text-foreground">
          {title}
        </div>
        <div className="font-sans text-sm font-normal text-muted">
          {description}
        </div>
      </div>
      </>}
    </Component>
  );
};
