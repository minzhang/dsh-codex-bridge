program HelloDesk;

var
  name: string;
  count: integer;

begin
  name := 'Pascal Desk';
  writeln('Welcome to ', name, '.');
  for count := 1 to 3 do
  begin
    writeln('Edit locally, save with F2, open with F3.');
  end;
end.
