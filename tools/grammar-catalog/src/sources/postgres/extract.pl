use strict;
use warnings FATAL => 'all';
use JSON::PP;
use File::Spec;

my $root = shift @ARGV or die "Expected acquired PostgreSQL source directory\n";
require File::Spec->catfile($root, 'src/backend/catalog/Catalog.pm');
my %catalogs;
my $catalog_directory = File::Spec->catdir($root, 'src/include/catalog');
opendir(my $directory, $catalog_directory) or die "$catalog_directory: $!\n";
my @files = sort grep { /\.dat\z/ } readdir($directory);
closedir($directory);
for my $filename (@files) {
    my $file = File::Spec->catfile($catalog_directory, $filename);
    (my $header_file = $file) =~ s/\.dat$/.h/;
    die "Missing catalog header: $header_file\n" unless -f $header_file;
    my $schema = Catalog::ParseHeader($header_file);
    my $rows = Catalog::ParseData($file, $schema->{columns}, 0);
    my $name = $schema->{catname};
    die "Missing or duplicate catalog name\n" if !$name || exists $catalogs{$name};
    $catalogs{$name} = { schema => $schema, rows => $rows };
}
die "No PostgreSQL catalogs\n" unless keys %catalogs;
print JSON::PP->new->canonical->encode(\%catalogs);
